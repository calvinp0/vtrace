// @ts-nocheck
import path from "node:path";
import type { Database } from "bun:sqlite";

import {
  CapsuleSupportSelectionPolicyId,
  type CapsuleProfileSelectionResult,
} from "../capsuleProfiles/types";
import type { CurrentObservationContext, Observation } from "../observations/types";
import type { GraphSearchResult } from "../retrieval/types";
import { getIndexedSkeletonFileResult } from "../skeleton/getSkeleton";
import { canAddCapsuleItem, computeCapsuleBudgetUsage, computeCapsuleItemCost } from "./budget";
import { selectRelevantProjectRules } from "../projectRules/projectRules";
import type { BuildCapsuleInput, CapsuleBuilder } from "./buildCapsule";
import {
  extractPivotSymbolContent,
  extractSupportSymbolContent,
  type ExtractedSymbolContentFields,
} from "./extractSymbolContent";
import { loadSymbolSource, type LoadSymbolSourceResult } from "./loadSymbolSource";
import { selectCapsuleMemories } from "./selectCapsuleMemories";
import {
  CapsuleContentMode,
  CapsuleFileRepresentationMode,
  CapsuleInclusionReasonKind,
  CapsuleItemRole,
  isCompressedCapsuleContentMode,
  type Capsule,
  type CapsuleBudget,
  type CapsuleInclusionReason,
  type CapsuleItem,
  type CapsuleItemContent,
  type CapsuleMemoryItem,
  type CapsuleProfileBudgetUsage,
  type CapsuleRuleItem,
  type CapsuleSupportingCandidate,
  type PivotCapsuleItem,
  type SupportCapsuleItem,
} from "./types";

type CandidateWithOptionalContent = ExtractedSymbolContentFields & {
  source?: string;
  signature?: string;
  summary?: string;
  docstring?: string;
};

type PivotInputCandidate = GraphSearchResult & CandidateWithOptionalContent;
type SupportInputCandidate = CapsuleSupportingCandidate & CandidateWithOptionalContent;

interface ContentVariant {
  representationMode: CapsuleFileRepresentationMode;
  content: CapsuleItemContent;
  sourceBacked?: boolean;
}

interface CapsuleAssemblyConfig {
  profileSelection?: CapsuleProfileSelectionResult;
  maxPivotCount: number;
  maxSupportCount: number;
  pivotModeOrder: readonly CapsuleContentMode[];
  supportModeOrder: readonly CapsuleContentMode[];
  pivotBudgetMax?: number;
  supportBudgetMax?: number;
  supportSelectionPolicy?: CapsuleSupportSelectionPolicyId;
}

interface RoleBudgetState {
  usedCharacters: number;
  maxCharacters?: number;
}

interface CapsuleItemSeed {
  repoAlias?: string;
  symbolId: string;
  filePath: string;
  fqName: string;
  localName: string;
  kind: GraphSearchResult["kind"];
  inclusionReasons: CapsuleInclusionReason[];
  lexicalScore?: number;
  graphScore?: number;
  finalScore?: number;
}

interface CapsuleContentProvider {
  loadPivotContent(candidate: GraphSearchResult): CandidateWithOptionalContent;
  loadSupportContent(candidate: CapsuleSupportingCandidate): CandidateWithOptionalContent;
}

interface CapsuleMemorySelector {
  build(input: {
    readonly query: string;
    readonly maxBudget: CapsuleBudget;
    readonly currentCost: number;
    readonly profileSelection?: CapsuleProfileSelectionResult;
    readonly pivots: readonly PivotCapsuleItem[];
    readonly supportingItems: readonly SupportCapsuleItem[];
  }): readonly CapsuleMemoryItem[];
}

interface CapsuleRuleSelector {
  build(input: {
    readonly query: string;
    readonly profileSelection?: CapsuleProfileSelectionResult;
    readonly pivots: readonly PivotCapsuleItem[];
    readonly supportingItems: readonly SupportCapsuleItem[];
  }): readonly CapsuleRuleItem[];
}

export interface SourceBackedCapsuleBuilderOptions {
  db: Database;
  repoRoot: string;
  currentObservationContext?: CurrentObservationContext;
  excludeMemoryObservation?: (input: {
    observation: Observation;
    query: string;
    profileSelection?: CapsuleProfileSelectionResult;
    pivots: readonly PivotCapsuleItem[];
    supportingItems: readonly SupportCapsuleItem[];
  }) => boolean;
}

const EMPTY_CONTENT_PROVIDER: CapsuleContentProvider = {
  loadPivotContent() {
    return {};
  },
  loadSupportContent() {
    return {};
  },
};

const EMPTY_MEMORY_SELECTOR: CapsuleMemorySelector = {
  build() {
    return [];
  },
};

const EMPTY_RULE_SELECTOR: CapsuleRuleSelector = {
  build() {
    return [];
  },
};

const DEFAULT_MAX_ITEM_COUNT = Number.MAX_SAFE_INTEGER;
const DEFAULT_PIVOT_MODE_ORDER = Object.freeze([
  CapsuleContentMode.Full,
  CapsuleContentMode.Summary,
  CapsuleContentMode.SignatureOnly,
  CapsuleContentMode.Stub,
]) satisfies readonly CapsuleContentMode[];
const DEFAULT_SUPPORT_MODE_ORDER = Object.freeze([
  CapsuleContentMode.Skeleton,
  CapsuleContentMode.SignatureOnly,
  CapsuleContentMode.Summary,
  CapsuleContentMode.Stub,
]) satisfies readonly CapsuleContentMode[];

export const deterministicCapsuleBuilder = createDeterministicCapsuleBuilder();

export function createDeterministicCapsuleBuilder(
  contentProvider: CapsuleContentProvider = EMPTY_CONTENT_PROVIDER,
  memorySelector: CapsuleMemorySelector = EMPTY_MEMORY_SELECTOR,
  ruleSelector: CapsuleRuleSelector = EMPTY_RULE_SELECTOR,
): CapsuleBuilder {
  return {
    build(input) {
      return buildDeterministicCapsule(input, contentProvider, memorySelector, ruleSelector);
    },
  };
}

export function createSourceBackedCapsuleBuilder(
  options: SourceBackedCapsuleBuilderOptions,
): CapsuleBuilder {
  return createDeterministicCapsuleBuilder(
    createSourceBackedContentProvider(options),
    {
      build(input) {
        return selectCapsuleMemories({
          db: options.db,
          query: input.query,
          intent: input.profileSelection?.profile.targetIntent,
          pivots: input.pivots,
          supportingItems: input.supportingItems,
          budget: input.maxBudget,
          currentCost: input.currentCost,
          currentContext: options.currentObservationContext,
          excludeObservation: options.excludeMemoryObservation === undefined
            ? undefined
            : (observation) => {
              return options.excludeMemoryObservation!({
                observation,
                query: input.query,
                profileSelection: input.profileSelection,
                pivots: input.pivots,
                supportingItems: input.supportingItems,
              });
            },
        });
      },
    },
    {
      build(input) {
        const contextItems = [...input.pivots, ...input.supportingItems];
        const selected = selectRelevantProjectRules(options.db, {
          repoRoot: options.repoRoot,
          query: input.query,
          intent: input.profileSelection?.profile.targetIntent,
          linkedFilePaths: collectSortedUnique(contextItems.map((item) => item.filePath)),
          linkedFqNames: collectSortedUnique(contextItems.map((item) => item.fqName)),
          maxCandidates: 0,
        });

        return selected.active.map((selection) => ({
          id: selection.rule.id,
          status: "active",
          summary: selection.rule.summary,
          scope: {
            files: [...selection.rule.scope.files],
            symbolFqns: [...selection.rule.scope.symbolFqns],
            terms: [...selection.rule.scope.terms],
          },
          reason: selection.reason,
        }));
      },
    },
  );
}

export function buildDeterministicCapsule(
  input: BuildCapsuleInput,
  contentProvider: CapsuleContentProvider = EMPTY_CONTENT_PROVIDER,
  memorySelector: CapsuleMemorySelector = EMPTY_MEMORY_SELECTOR,
  ruleSelector: CapsuleRuleSelector = EMPTY_RULE_SELECTOR,
): Capsule {
  const assemblyConfig = resolveCapsuleAssemblyConfig(input);
  const pivots: PivotCapsuleItem[] = [];
  const supportingItems: SupportCapsuleItem[] = [];
  const includedSymbolIds = new Set<string>();
  const currentBudget = {
    usedCharacters: input.query.length,
  };
  const pivotBudgetState: RoleBudgetState = {
    usedCharacters: 0,
    ...(assemblyConfig.pivotBudgetMax === undefined ? {} : { maxCharacters: assemblyConfig.pivotBudgetMax }),
  };
  const supportBudgetState: RoleBudgetState = {
    usedCharacters: 0,
    ...(assemblyConfig.supportBudgetMax === undefined ? {} : { maxCharacters: assemblyConfig.supportBudgetMax }),
  };
  let truncated = false;
  let compressed = false;

  for (const candidate of input.rerankedCandidates) {
    if (pivots.length >= assemblyConfig.maxPivotCount) {
      truncated = true;
      break;
    }

    if (includedSymbolIds.has(candidate.symbolId)) {
      continue;
    }

    const pivot = selectPivotItem(
      {
        ...candidate,
        ...contentProvider.loadPivotContent(candidate),
      } as PivotInputCandidate,
      currentBudget.usedCharacters,
      input.maxBudget,
      pivotBudgetState,
      assemblyConfig.pivotModeOrder,
    );

    if (pivot === undefined) {
      truncated = true;
      continue;
    }

    pivots.push(pivot);
    includedSymbolIds.add(pivot.symbolId);
    currentBudget.usedCharacters += pivot.budgetCost;
    pivotBudgetState.usedCharacters += pivot.budgetCost;
    compressed ||= pivot.compressed;
  }

  for (const candidate of orderSupportCandidates(
    input.supportingCandidates ?? [],
    assemblyConfig.supportSelectionPolicy,
  )) {
    if (supportingItems.length >= assemblyConfig.maxSupportCount) {
      truncated = true;
      break;
    }

    if (includedSymbolIds.has(candidate.symbolId)) {
      continue;
    }

    const support = selectSupportItem(
      {
        ...candidate,
        ...contentProvider.loadSupportContent(candidate),
      } as SupportInputCandidate,
      currentBudget.usedCharacters,
      input.maxBudget,
      supportBudgetState,
      assemblyConfig.supportModeOrder,
    );

    if (support === undefined) {
      truncated = true;
      continue;
    }

    supportingItems.push(support);
    includedSymbolIds.add(support.symbolId);
    currentBudget.usedCharacters += support.budgetCost;
    supportBudgetState.usedCharacters += support.budgetCost;
    compressed ||= support.compressed;
  }

  const memories = memorySelector.build({
    query: input.query,
    maxBudget: input.maxBudget,
    currentCost: currentBudget.usedCharacters,
    profileSelection: assemblyConfig.profileSelection,
    pivots,
    supportingItems,
  });
  const rules = ruleSelector.build({
    query: input.query,
    profileSelection: assemblyConfig.profileSelection,
    pivots,
    supportingItems,
  });

  return {
    query: input.query,
    pivots,
    supportingItems,
    ...(memories.length === 0 ? {} : { memories: [...memories] }),
    ...(rules.length === 0 ? {} : { rules: { active: [...rules] } }),
    budget: computeCapsuleBudgetUsage(
      { query: input.query, pivots, supportingItems, memories, rules: { active: rules } },
      input.maxBudget,
    ),
    truncated,
    compressed,
    ...(assemblyConfig.profileSelection === undefined
      ? {}
      : {
        profileSelection: assemblyConfig.profileSelection,
        profileBudgetUsage: makeCapsuleProfileBudgetUsage(
          pivotBudgetState,
          supportBudgetState,
        ),
      }),
  };
}

function selectPivotItem(
  candidate: PivotInputCandidate,
  currentCost: number,
  budget: CapsuleBudget,
  roleBudgetState: RoleBudgetState,
  modeOrder: readonly CapsuleContentMode[],
): PivotCapsuleItem | undefined {
  return selectCapsuleItem(
    CapsuleItemRole.Pivot,
    makeCapsuleItemSeed(candidate, buildPivotInclusionReasons(candidate)),
    buildPivotContentVariants(candidate, modeOrder),
    currentCost,
    budget,
    roleBudgetState,
  );
}

function selectSupportItem(
  candidate: SupportInputCandidate,
  currentCost: number,
  budget: CapsuleBudget,
  roleBudgetState: RoleBudgetState,
  modeOrder: readonly CapsuleContentMode[],
): SupportCapsuleItem | undefined {
  return selectCapsuleItem(
    CapsuleItemRole.Support,
    makeCapsuleItemSeed(candidate, [...candidate.inclusionReasons]),
    buildSupportContentVariants(candidate, modeOrder),
    currentCost,
    budget,
    roleBudgetState,
  );
}

function makeCapsuleItemSeed(
  candidate: GraphSearchResult | CapsuleSupportingCandidate,
  inclusionReasons: CapsuleInclusionReason[],
): CapsuleItemSeed {
  return {
    ...(candidate.repoAlias === undefined ? {} : { repoAlias: candidate.repoAlias }),
    symbolId: candidate.symbolId,
    filePath: candidate.filePath,
    fqName: candidate.fqName,
    localName: candidate.localName,
    kind: candidate.kind,
    inclusionReasons,
    lexicalScore: candidate.lexicalScore,
    graphScore: candidate.graphScore,
    finalScore: candidate.finalScore,
  };
}

function buildPivotInclusionReasons(
  candidate: GraphSearchResult,
): CapsuleInclusionReason[] {
  const reasons: CapsuleInclusionReason[] = [
    {
      kind: CapsuleInclusionReasonKind.LexicalMatch,
      matchedFields: collectUniqueInOrder(candidate.matches.map((match) => match.field)),
    },
  ];
  const graphSignals = collectUniqueInOrder(candidate.graphContributions.map((contribution) => contribution.signal));
  const relatedSymbolIds = collectSortedUnique(
    candidate.graphContributions.flatMap((contribution) => contribution.relatedSymbolIds ?? []),
  );

  if (graphSignals.length > 0) {
    reasons.push({
      kind: CapsuleInclusionReasonKind.GraphConnection,
      graphSignals,
      ...(relatedSymbolIds.length === 0 ? {} : { relatedSymbolIds }),
    });
  }

  return reasons;
}

// Keep the fallback ladders centralized so budget downgrades stay explicit.
function buildPivotContentVariants(
  candidate: PivotInputCandidate,
  modeOrder: readonly CapsuleContentMode[] = DEFAULT_PIVOT_MODE_ORDER,
): ContentVariant[] {
  const source = readOptionalText(candidate, "source");
  const summary = firstDefined(
    readOptionalText(candidate, "summary"),
    readOptionalText(candidate, "docstring"),
  );
  const signature = readOptionalText(candidate, "signature");
  const stub = readOptionalText(candidate, "stub") || candidate.localName;
  const variantsByMode = new Map<CapsuleContentMode, ContentVariant>();

  if (source !== undefined) {
    variantsByMode.set(CapsuleContentMode.Full, {
      representationMode: CapsuleFileRepresentationMode.FullSource,
      content: {
        mode: CapsuleContentMode.Full,
        source,
      },
      sourceBacked: candidate.sourceBacked === true,
    });
  }

  if (summary !== undefined) {
    variantsByMode.set(CapsuleContentMode.Summary, {
      representationMode: CapsuleFileRepresentationMode.FullSource,
      content: {
        mode: CapsuleContentMode.Summary,
        summary,
        ...(signature === undefined ? {} : { signature }),
      },
    });
  }

  if (signature !== undefined) {
    variantsByMode.set(CapsuleContentMode.SignatureOnly, {
      representationMode: CapsuleFileRepresentationMode.FullSource,
      content: {
        mode: CapsuleContentMode.SignatureOnly,
        signature,
      },
    });
  }

  variantsByMode.set(CapsuleContentMode.Stub, {
    representationMode: CapsuleFileRepresentationMode.FullSource,
    content: {
      mode: CapsuleContentMode.Stub,
      stub,
    },
  });

  return orderContentVariants(variantsByMode, modeOrder);
}

function buildSupportContentVariants(
  candidate: SupportInputCandidate,
  modeOrder: readonly CapsuleContentMode[] = DEFAULT_SUPPORT_MODE_ORDER,
): ContentVariant[] {
  if (candidate.skeleton !== undefined) {
    return [
      {
        representationMode: CapsuleFileRepresentationMode.Skeleton,
        content: {
          mode: CapsuleContentMode.Skeleton,
          detail: candidate.skeletonDetail ?? "standard",
          file: candidate.skeleton,
        },
      },
    ];
  }

  const signature = readOptionalText(candidate, "signature");
  const summary = firstDefined(
    readOptionalText(candidate, "summary"),
    readOptionalText(candidate, "docstring"),
  );
  const stub = readOptionalText(candidate, "stub") || candidate.localName;
  const variantsByMode = new Map<CapsuleContentMode, ContentVariant>();

  if (signature !== undefined) {
    variantsByMode.set(CapsuleContentMode.SignatureOnly, {
      representationMode: CapsuleFileRepresentationMode.FullSource,
      content: {
        mode: CapsuleContentMode.SignatureOnly,
        signature,
      },
    });
  }

  if (summary !== undefined) {
    variantsByMode.set(CapsuleContentMode.Summary, {
      representationMode: CapsuleFileRepresentationMode.FullSource,
      content: {
        mode: CapsuleContentMode.Summary,
        summary,
      },
    });
  }

  variantsByMode.set(CapsuleContentMode.Stub, {
    representationMode: CapsuleFileRepresentationMode.FullSource,
    content: {
      mode: CapsuleContentMode.Stub,
      stub,
    },
  });

  return orderContentVariants(variantsByMode, modeOrder);
}

function selectCapsuleItem(
  role: CapsuleItemRole.Pivot,
  seed: CapsuleItemSeed,
  variants: readonly ContentVariant[],
  currentCost: number,
  budget: CapsuleBudget,
): PivotCapsuleItem | undefined;
function selectCapsuleItem(
  role: CapsuleItemRole.Support,
  seed: CapsuleItemSeed,
  variants: readonly ContentVariant[],
  currentCost: number,
  budget: CapsuleBudget,
): SupportCapsuleItem | undefined;
function selectCapsuleItem(
  role: CapsuleItemRole,
  seed: CapsuleItemSeed,
  variants: readonly ContentVariant[],
  currentCost: number,
  budget: CapsuleBudget,
  roleBudgetState: RoleBudgetState,
): CapsuleItem | undefined {
  const preferredMode = variants[0]?.content.mode;

  if (preferredMode === undefined) {
    return undefined;
  }

  for (const variant of variants) {
    const inclusionReasons = variant.content.mode === preferredMode
      ? seed.inclusionReasons
      : [
        ...seed.inclusionReasons,
        {
          kind: CapsuleInclusionReasonKind.BudgetCompression,
          originalMode: preferredMode,
          appliedMode: variant.content.mode,
        },
      ];
    const item = createCapsuleItem(
      role,
      seed,
      inclusionReasons,
      variant.content,
      variant.sourceBacked === true,
    );

    if (
      canAddCapsuleItem(currentCost, item, budget)
      && fitsWithinRoleBudget(roleBudgetState, item)
    ) {
      return item;
    }
  }

  return undefined;
}

function createCapsuleItem(
  role: CapsuleItemRole.Pivot,
  seed: CapsuleItemSeed,
  inclusionReasons: CapsuleInclusionReason[],
  content: CapsuleItemContent,
  sourceBacked: boolean,
): PivotCapsuleItem;
function createCapsuleItem(
  role: CapsuleItemRole.Support,
  seed: CapsuleItemSeed,
  inclusionReasons: CapsuleInclusionReason[],
  content: CapsuleItemContent,
  sourceBacked: boolean,
): SupportCapsuleItem;
function createCapsuleItem(
  role: CapsuleItemRole,
  seed: CapsuleItemSeed,
  inclusionReasons: CapsuleInclusionReason[],
  content: CapsuleItemContent,
  sourceBacked: boolean,
): CapsuleItem {
  const item = {
    ...(seed.repoAlias === undefined ? {} : { repoAlias: seed.repoAlias }),
    symbolId: seed.symbolId,
    filePath: seed.filePath,
    fqName: seed.fqName,
    localName: seed.localName,
    kind: seed.kind,
    role,
    inclusionReasons,
    content,
    budgetCost: 0,
    compressed: isCompressedCapsuleContentMode(content.mode),
    ...(sourceBacked ? { sourceBacked: true } : {}),
    lexicalScore: seed.lexicalScore,
    graphScore: seed.graphScore,
    finalScore: seed.finalScore,
  } satisfies CapsuleItem;

  return {
    ...item,
    budgetCost: computeCapsuleItemCost(item),
  };
}

function readOptionalText(
  candidate: CandidateWithOptionalContent,
  field: keyof CandidateWithOptionalContent,
): string | undefined {
  const value = candidate[field];

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstDefined(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined);
}

function resolveCapsuleAssemblyConfig(input: BuildCapsuleInput): CapsuleAssemblyConfig {
  const profileSelection = input.profileSelection;
  const profile = profileSelection?.profile;

  if (profile === undefined) {
    return {
      maxPivotCount: DEFAULT_MAX_ITEM_COUNT,
      maxSupportCount: DEFAULT_MAX_ITEM_COUNT,
      pivotModeOrder: DEFAULT_PIVOT_MODE_ORDER,
      supportModeOrder: DEFAULT_SUPPORT_MODE_ORDER,
    };
  }

  const contentBudget = Math.max(0, input.maxBudget.maxCharacters - input.query.length);

  return {
    profileSelection,
    maxPivotCount: profile.maxPivotCount,
    maxSupportCount: profile.maxSupportCount,
    pivotModeOrder: resolveModeOrder(
      profile.preferredPivotContentModes,
      profile.pivotFallbackLadder,
      DEFAULT_PIVOT_MODE_ORDER,
    ),
    supportModeOrder: resolveModeOrder(
      profile.preferredSupportContentModes,
      profile.supportFallbackLadder,
      DEFAULT_SUPPORT_MODE_ORDER,
    ),
    ...(profile.budgetSplit === undefined
      ? {}
      : {
        pivotBudgetMax: Math.floor(contentBudget * profile.budgetSplit.pivotFraction),
        supportBudgetMax: Math.floor(contentBudget * profile.budgetSplit.supportFraction),
      }),
    supportSelectionPolicy: profile.supportSelectionPolicy,
  };
}

function resolveModeOrder(
  preferredModes: readonly CapsuleContentMode[],
  fallbackModes: readonly CapsuleContentMode[],
  defaultModes: readonly CapsuleContentMode[],
): readonly CapsuleContentMode[] {
  const orderedModes = collectUniqueInOrder([...preferredModes, ...fallbackModes]);

  return Object.freeze(orderedModes.length === 0 ? [...defaultModes] : orderedModes);
}

function orderContentVariants(
  variantsByMode: ReadonlyMap<CapsuleContentMode, ContentVariant>,
  modeOrder: readonly CapsuleContentMode[],
): ContentVariant[] {
  const variants: ContentVariant[] = [];

  for (const mode of modeOrder) {
    const variant = variantsByMode.get(mode);

    if (variant !== undefined) {
      variants.push(variant);
    }
  }

  return variants;
}

function orderSupportCandidates(
  candidates: readonly CapsuleSupportingCandidate[],
  policy: CapsuleSupportSelectionPolicyId | undefined,
): CapsuleSupportingCandidate[] {
  if (policy === undefined) {
    return [...candidates];
  }

  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => compareSupportCandidates(left, right, policy))
    .map((entry) => entry.candidate);
}

function compareSupportCandidates(
  left: { candidate: CapsuleSupportingCandidate; index: number },
  right: { candidate: CapsuleSupportingCandidate; index: number },
  policy: CapsuleSupportSelectionPolicyId,
): number {
  switch (policy) {
    case CapsuleSupportSelectionPolicyId.ConservativeDirect:
      return (
        compareOptionalNumberDescending(left.candidate.finalScore, right.candidate.finalScore)
        || compareOptionalNumberDescending(left.candidate.lexicalScore, right.candidate.lexicalScore)
        || compareOptionalNumberDescending(left.candidate.graphScore, right.candidate.graphScore)
        || left.index - right.index
      );
    case CapsuleSupportSelectionPolicyId.StructuralBroad:
      return (
        countStructuralSupportStrength(right.candidate) - countStructuralSupportStrength(left.candidate)
        || compareOptionalNumberDescending(left.candidate.graphScore, right.candidate.graphScore)
        || compareOptionalNumberDescending(left.candidate.finalScore, right.candidate.finalScore)
        || compareOptionalNumberDescending(left.candidate.lexicalScore, right.candidate.lexicalScore)
        || left.index - right.index
      );
    case CapsuleSupportSelectionPolicyId.LowNoiseStable:
      return (
        compareOptionalNumberDescending(left.candidate.lexicalScore, right.candidate.lexicalScore)
        || compareOptionalNumberDescending(left.candidate.finalScore, right.candidate.finalScore)
        || compareOptionalNumberDescending(left.candidate.graphScore, right.candidate.graphScore)
        || left.index - right.index
      );
    case CapsuleSupportSelectionPolicyId.ExtensionBalanced:
      return (
        compareOptionalNumberDescending(left.candidate.finalScore, right.candidate.finalScore)
        || compareOptionalNumberDescending(left.candidate.graphScore, right.candidate.graphScore)
        || countStructuralSupportStrength(right.candidate) - countStructuralSupportStrength(left.candidate)
        || compareOptionalNumberDescending(left.candidate.lexicalScore, right.candidate.lexicalScore)
        || left.index - right.index
      );
  }
}

function compareOptionalNumberDescending(
  left: number | undefined,
  right: number | undefined,
): number {
  const normalizedLeft = left ?? Number.NEGATIVE_INFINITY;
  const normalizedRight = right ?? Number.NEGATIVE_INFINITY;

  if (normalizedLeft === normalizedRight) {
    return 0;
  }

  return normalizedRight > normalizedLeft ? 1 : -1;
}

function countStructuralSupportStrength(candidate: CapsuleSupportingCandidate): number {
  return candidate.inclusionReasons.reduce((sum, reason) => {
    return reason.kind === CapsuleInclusionReasonKind.StructuralSupport
      ? sum + reason.relatedSymbolIds.length
      : sum;
  }, 0);
}

function fitsWithinRoleBudget(
  roleBudgetState: RoleBudgetState,
  item: CapsuleItem,
): boolean {
  return roleBudgetState.maxCharacters === undefined
    || roleBudgetState.usedCharacters + item.budgetCost <= roleBudgetState.maxCharacters;
}

function makeCapsuleProfileBudgetUsage(
  pivotBudgetState: RoleBudgetState,
  supportBudgetState: RoleBudgetState,
): CapsuleProfileBudgetUsage {
  return {
    pivotCharactersUsed: pivotBudgetState.usedCharacters,
    supportCharactersUsed: supportBudgetState.usedCharacters,
    ...(pivotBudgetState.maxCharacters === undefined
      ? {}
      : { pivotCharactersMax: pivotBudgetState.maxCharacters }),
    ...(supportBudgetState.maxCharacters === undefined
      ? {}
      : { supportCharactersMax: supportBudgetState.maxCharacters }),
  };
}

function collectUniqueInOrder<T>(values: readonly T[]): T[] {
  const uniqueValues: T[] = [];
  const seen = new Set<T>();

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    uniqueValues.push(value);
  }

  return uniqueValues;
}

function collectSortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function createSourceBackedContentProvider(
  options: SourceBackedCapsuleBuilderOptions,
): CapsuleContentProvider {
  const repoRoot = path.resolve(options.repoRoot);
  const sourceCache = new Map<string, LoadSymbolSourceResult>();
  const skeletonCache = new Map<string, CandidateWithOptionalContent["skeleton"]>();

  function load(symbolId: string): LoadSymbolSourceResult {
    const cached = sourceCache.get(symbolId);

    if (cached !== undefined) {
      return cached;
    }

    const loaded = loadSymbolSource(options.db, repoRoot, symbolId);
    sourceCache.set(symbolId, loaded);
    return loaded;
  }

  function loadSkeleton(filePath: string) {
    const cached = skeletonCache.get(filePath);

    if (cached !== undefined) {
      return cached;
    }

    const loaded = getIndexedSkeletonFileResult(options.db, filePath, "standard");
    skeletonCache.set(filePath, loaded);
    return loaded;
  }

  return {
    loadPivotContent(candidate) {
      return extractPivotSymbolContent(load(candidate.symbolId), candidate.localName);
    },
    loadSupportContent(candidate) {
      const skeleton = loadSkeleton(candidate.filePath);

      return {
        ...extractSupportSymbolContent(load(candidate.symbolId), candidate.localName),
        ...(skeleton === undefined
          ? {}
          : {
            skeleton,
            skeletonDetail: "standard" as const,
          }),
      };
    },
  };
}
