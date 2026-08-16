import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";

import {
  buildAuthoritativeProductRetrieval,
  PRODUCT_RETRIEVAL_CHARS_PER_TOKEN,
  type AuthoritativeProductRetrieval,
} from "../capsuleV2/authoritativeProductRetrieval";
import { toCapsuleV2ProductResponse, type CapsuleV2ProductItem } from "../capsuleV2/productAdapter";
import { CapsuleIntent } from "../capsuleV2/types";
import { RunPipelinePresetIntent, type RunPipelineConcretePreset } from "../runPipeline/types";
import { estimateTokens, roundPercent } from "../capsuleV2/tokens";
import { listSymbolsByFqName } from "../db/repositories/symbolsRepository";
import { getLatestIndexRun } from "../db/repositories/indexRunsRepository";
import { SymbolKind, type SymbolRecord } from "../domain/types";
import { getImpactGraph } from "../impact/getImpactGraph";
import { readIndexMeta } from "../indexer/indexMeta";
import { inspectWorktreeIndexFreshness } from "../indexer/indexReadiness";
import { resolveWorktreeIdentity } from "../indexer/worktreeIdentity";
import { StaleStateStatus } from "../memory/types";
import { searchMemory } from "../observations/searchMemory";
import type { ProductStores } from "../session/sessionStore";
import { resolveCurrentObservationContext } from "../observations/provenance";
import type { CurrentObservationContext } from "../observations/types";
import { selectRelevantProjectRules } from "../projectRules/projectRules";
import { getIndexedSkeletonFileResult } from "../skeleton/getSkeleton";
import {
  PRODUCT_CONTEXT_RESPONSE_VERSION,
  PRODUCT_CONTEXT_ROLES,
  type ProductAccounting,
  type ProductContextContentMode,
  type ProductContextItem,
  type ProductContextResponse,
  type ProductContextRole,
} from "./types";

export const PRODUCT_CONTEXT_BASELINE =
  "full source contents of every unique selected source file before compression; duplicates and generated response metadata excluded";
export const PRODUCT_CONTEXT_CLAIM_BOUNDARY =
  "Compression relative to uniquely selected full files; not the repository, provider-billed tokens, or exact tokenizer usage.";

const MAX_IMPACT_PIVOTS = 2;
const MAX_IMPACT_EDGES_PER_PIVOT = 6;
const MAX_IMPACT_ITEMS = 10;
const MAX_TOTAL_IMPACT_CHARS = 2_400;
const MAX_MEMORY_ITEMS = 3;
const MAX_RULE_ITEMS = 3;
const MAX_SUMMARY_CHARS = 320;

export interface AssembleProductContextInput {
  /**
   * Repository evidence and product/session state. Both are READ here: the
   * capsule comes from the index, memory and rules from the session store, and
   * assembling a product context writes to neither (§22).
   */
  stores: ProductStores;
  repoRoot: string;
  task: string;
  intent?: CapsuleIntent;
  budgetTokens?: number;
  sessionId?: string;
  freshnessOverride?: {
    status?: string;
    reason?: string;
    action?: string;
    refreshDiagnostics?: unknown;
  };
  indexRefreshMs?: number;
  now?: () => number;
  /** Request-local authority from an outer product tool; avoids rebuilding v2. */
  authoritativeRetrieval?: AuthoritativeProductRetrieval;
}

export function buildUnresolvedProductContext(input: {
  task: string;
  repoRoot: string;
  repositoryId: string;
  worktreeId: string;
  headCommit: string | null;
  branch: string | null;
  detached: boolean;
  freshnessStatus: string;
  freshnessReason: string;
  freshnessAction: string;
  refreshDiagnostics?: unknown;
  totalMs: number;
  intent?: string;
  budgetTokens?: number | null;
  indexRunId?: number | string | null;
  indexMode?: "noop" | "incremental" | "full_rebuild" | null;
}): ProductContextResponse {
  const roleCounts = Object.fromEntries(PRODUCT_CONTEXT_ROLES.map((role) => [role, 0])) as Record<ProductContextRole, number>;
  return {
    responseVersion: PRODUCT_CONTEXT_RESPONSE_VERSION,
    resolved: false,
    task: input.task,
    taskHash: hash(input.task),
    intent: input.intent ?? "auto",
    capsuleMode: "no_context",
    leadPivot: null,
    selectedFileHash: hash(""),
    repository: {
      root: input.repoRoot,
      repositoryId: input.repositoryId,
      worktreeId: input.worktreeId,
      headCommit: input.headCommit,
      branch: input.branch,
      detached: input.detached,
      indexRunId: input.indexRunId ?? null,
      indexMode: input.indexMode ?? null,
    },
    freshness: {
      status: input.freshnessStatus,
      reason: input.freshnessReason,
      action: input.freshnessAction,
      refreshDiagnostics: input.refreshDiagnostics ?? null,
    },
    accounting: {
      budgetTokens: input.budgetTokens ?? null,
      renderedCharacters: 0,
      usedTokensEstimate: 0,
      naiveTokensEstimate: null,
      savedTokensEstimate: null,
      reductionPercent: null,
      remainingTokensEstimate: null,
      duplicateItemCountRemoved: 0,
      duplicateCharactersRemoved: 0,
      duplicateTokensEstimateRemoved: 0,
      estimateMethod: "character_ratio",
      estimateExact: false,
      baseline: PRODUCT_CONTEXT_BASELINE,
      claimBoundary: PRODUCT_CONTEXT_CLAIM_BOUNDARY,
    },
    timing: {
      freshnessMs: input.totalMs,
      retrievalMs: 0,
      capsuleBuildMs: 0,
      impactMs: 0,
      memoryRulesMs: 0,
      renderMs: 0,
      totalMs: input.totalMs,
    },
    roleCounts,
    items: [],
    modelVisibleContext: "",
    diagnostics: {
      staticEvidenceOnly: true,
      limitations: ["No model-visible context was assembled because the selected index was not fresh."],
      selectedFiles: [],
      requiredFiles: [],
      supportFiles: [],
      duplicatePolicy: "one rendered body per path and symbol identity; roles are merged",
    },
  };
}

interface DraftItem extends Omit<ProductContextItem, "id" | "stableId" | "estimatedTokens"> {
  identity: string;
  roleOrder: number;
}

/**
 * The one M119 assembly layer used by every primary product path. Retrieval and
 * role selection remain delegated to Capsule v2; this layer only normalizes,
 * enriches, deduplicates, renders, and accounts for those selected results.
 */
export async function assembleProductContext(
  input: AssembleProductContextInput,
): Promise<ProductContextResponse> {
  const now = input.now ?? (() => performance.now());
  const totalStarted = now();
  const budgetTokens = input.budgetTokens ?? 8_000;

  const freshnessStarted = now();
  const [identity, indexMeta, inspectedFreshness, observationContext] = await Promise.all([
    resolveWorktreeIdentity(input.repoRoot),
    readIndexMeta(input.repoRoot),
    input.freshnessOverride === undefined ? inspectWorktreeIndexFreshness(input.repoRoot) : Promise.resolve(null),
    resolveCurrentObservationContext(input.repoRoot),
  ]);
  const freshnessMs = elapsed(freshnessStarted, now());
  const freshness: NonNullable<AssembleProductContextInput["freshnessOverride"]> = input.freshnessOverride ?? {
    status: inspectedFreshness?.status ?? "unknown",
    reason: inspectedFreshness?.reason ?? "unknown",
    action: inspectedFreshness?.action ?? "none",
  };
  const indexMode = indexMeta?.manifest.performance?.mode ?? null;

  // The normalized product response never renders or accounts for source from a
  // stale, missing, or otherwise untrusted snapshot. Legacy outer wrappers retain
  // their existing behavior, but this shared model-facing contract fails closed.
  if (freshness.status !== "fresh") {
    return buildUnresolvedProductContext({
      task: input.task,
      repoRoot: identity.worktree.worktreeRoot,
      repositoryId: identity.repository.repositoryId,
      worktreeId: identity.worktree.worktreeId,
      headCommit: identity.snapshot.headCommit,
      branch: identity.snapshot.branch,
      detached: identity.snapshot.detached,
      freshnessStatus: freshness.status ?? "unknown",
      freshnessReason: freshness.reason ?? "unknown",
      freshnessAction: freshness.action ?? "none",
      refreshDiagnostics: freshness.refreshDiagnostics,
      totalMs: Math.max(freshnessMs, elapsed(totalStarted, now())),
      intent: input.intent ?? CapsuleIntent.Auto,
      budgetTokens,
      indexRunId: indexMeta?.manifest.index.runId ?? getLatestIndexRun(input.stores.index)?.id ?? null,
      indexMode,
    });
  }

  // Capsule v2 owns deterministic candidate generation, scoring, pivot selection,
  // co-edit selection, and task derivation. M119 deliberately does not duplicate
  // or alter any of those policies.
  const capsuleBuildStarted = now();
  const authoritative = input.authoritativeRetrieval ?? buildAuthoritativeProductRetrieval(
    input.stores.index,
    input.repoRoot,
    {
      query: input.task,
      preset: presetForCapsuleIntent(input.intent ?? CapsuleIntent.Auto),
      maxBudgetCharacters: budgetTokens * PRODUCT_RETRIEVAL_CHARS_PER_TOKEN,
      capsuleIntent: input.intent ?? CapsuleIntent.Auto,
    },
  );
  const capsule = authoritative.result;
  const product = toCapsuleV2ProductResponse(capsule, { query: input.task });
  const capsuleBuildMs = elapsed(capsuleBuildStarted, now());
  // buildCapsuleV2 currently exposes no internal retrieval clock seam. Report the
  // whole synchronous operation as capsuleBuildMs and keep retrievalMs at zero
  // rather than double-counting the same elapsed interval.
  const retrievalMs = 0;

  const drafts: DraftItem[] = [];
  let roleOrder = 0;
  for (const pivot of product.pivots) {
    drafts.push(sourceDraft(input.stores.index, pivot, ["pivot", ...(isRequiredPivot(pivot) ? ["required" as const] : [])], roleOrder++));
  }
  for (const support of product.support) {
    const roles: ProductContextRole[] = ["support"];
    if (support.contentMode !== "full") roles.push("skeleton");
    if (isDocumentationPath(support.path)) roles.push("documentation");
    if (support.documentKind !== undefined) roles.push("configuration");
    drafts.push(sourceDraft(input.stores.index, support, roles, roleOrder++));
  }
  if (product.pivots.length > 0) {
    addActionabilityTargets(product.actionabilityHints, drafts, () => roleOrder++);
  }

  const impactStarted = now();
  if (product.pivots.length > 0) {
    addImpactEvidence(input.stores.index, input.repoRoot, product.pivots, drafts, () => roleOrder++);
  }
  const impactMs = elapsed(impactStarted, now());

  const memoryRulesStarted = now();
  if (product.pivots.length > 0) {
    addMemoryAndRules(input, observationContext, product, drafts, () => roleOrder++);
  }
  const memoryRulesMs = elapsed(memoryRulesStarted, now());

  const deduped = deduplicateDrafts(input.task, identity.worktree.worktreeId, drafts);
  const items = assignDisplayIds(deduped.items);
  attachStableContextReferences(items);
  const renderStarted = now();
  const modelVisibleContext = renderModelVisibleContext(input.task, identity.worktree.worktreeId, product.intent, product.actualMode, items);
  const renderMs = elapsed(renderStarted, now());

  const selectedFiles = unique(items.map((item) => item.path).filter((value): value is string => value !== undefined));
  const naiveTokensEstimate = items.length === 0
    ? null
    : await estimateUniqueFullFiles(input.repoRoot, selectedFiles);
  const accounting = buildAccounting({
    budgetTokens,
    modelVisibleContext,
    naiveTokensEstimate,
    duplicateItemCountRemoved: deduped.duplicateItemCountRemoved,
    duplicateCharactersRemoved: deduped.duplicateCharactersRemoved,
  });
  const roleCounts = Object.fromEntries(PRODUCT_CONTEXT_ROLES.map((role) => [role, 0])) as Record<ProductContextRole, number>;
  for (const item of items) for (const role of item.roles) roleCounts[role] += 1;

  const totalMs = elapsed(totalStarted, now());
  const requiredFiles = unique(items.filter((item) => item.roles.includes("required")).flatMap((item) => item.path ?? []));
  const supportFiles = unique(items.filter((item) => item.roles.includes("support")).flatMap((item) => item.path ?? []));

  return {
    responseVersion: PRODUCT_CONTEXT_RESPONSE_VERSION,
    resolved: product.actualMode !== "no_context" && product.pivots.length > 0,
    task: input.task,
    taskHash: hash(input.task),
    intent: product.intent,
    capsuleMode: product.actualMode,
    leadPivot: product.pivots[0] === undefined ? null : itemIdentity(product.pivots[0]),
    selectedFileHash: hash(selectedFiles.join("\n")),
    repository: {
      root: identity.worktree.worktreeRoot,
      repositoryId: identity.repository.repositoryId,
      worktreeId: identity.worktree.worktreeId,
      headCommit: identity.snapshot.headCommit,
      branch: identity.snapshot.branch,
      detached: identity.snapshot.detached,
      indexRunId: indexMeta?.manifest.index.runId ?? getLatestIndexRun(input.stores.index)?.id ?? null,
      indexMode,
    },
    freshness: {
      status: freshness.status ?? "unknown",
      reason: freshness.reason ?? "unknown",
      action: freshness.action ?? "none",
      refreshDiagnostics: freshness.refreshDiagnostics ?? null,
    },
    accounting,
    timing: {
      freshnessMs,
      retrievalMs,
      capsuleBuildMs,
      impactMs,
      memoryRulesMs,
      renderMs,
      totalMs: Math.max(totalMs, freshnessMs, retrievalMs, capsuleBuildMs, impactMs, memoryRulesMs, renderMs),
      ...(input.indexRefreshMs === undefined ? {} : { indexRefreshMs: input.indexRefreshMs }),
    },
    roleCounts,
    items,
    modelVisibleContext,
    diagnostics: {
      staticEvidenceOnly: true,
      limitations: [
        "Impact is bounded static structural graph evidence, not dynamic execution flow.",
        "Token estimates use a character ratio and are approximate.",
        "Return types are reported only when parser-backed signatures contain them.",
        "Capsule v2 does not expose an internal retrieval timing seam; capsuleBuildMs includes retrieval and retrievalMs is zero rather than double-counted.",
      ],
      selectedFiles,
      requiredFiles,
      supportFiles,
      duplicatePolicy: "one rendered body per path and symbol identity; roles are merged",
    },
  };
}

function presetForCapsuleIntent(intent: CapsuleIntent): RunPipelineConcretePreset {
  switch (intent) {
    case CapsuleIntent.Debug:
    case CapsuleIntent.TestFailure:
      return RunPipelinePresetIntent.Debug;
    case CapsuleIntent.Refactor:
      return RunPipelinePresetIntent.Refactor;
    case CapsuleIntent.Explain:
    case CapsuleIntent.Impact:
      return RunPipelinePresetIntent.Explore;
    default:
      return RunPipelinePresetIntent.Modify;
  }
}

function sourceDraft(db: Database, item: CapsuleV2ProductItem, roles: ProductContextRole[], roleOrder: number): DraftItem {
  const symbol = listSymbolsByFqName(db, item.fqName)[0];
  const structural = renderStructuralSkeleton(db, item.path, symbol);
  let contentMode: ProductContextContentMode;
  let content: string | undefined;
  let fallback: string;
  if (item.contentMode === "document_excerpt" && item.source) {
    contentMode = "document_excerpt";
    content = item.source;
    fallback = "document_excerpt";
  } else if (item.contentMode === "full" && item.source) {
    contentMode = "focused_source";
    content = item.source;
    fallback = "focused_source";
  } else if (structural.content) {
    contentMode = "skeleton";
    content = structural.content;
    fallback = structural.fallback;
  } else if (item.signature) {
    contentMode = "signature";
    content = item.signature;
    fallback = "signature_only";
  } else {
    contentMode = "summary";
    content = undefined;
    fallback = "metadata_only";
  }
  return {
    identity: itemIdentity(item),
    roleOrder,
    path: item.path,
    symbol: item.symbol,
    roles,
    contentMode,
    ...(symbol
      ? { lineSpan: { start: symbol.startLine, end: symbol.endLine } }
      : item.lineSpans?.[0] === undefined
        ? {}
        : {
            lineSpan: {
              start: Math.min(...item.lineSpans.map((span) => span.start)),
              end: Math.max(...item.lineSpans.map((span) => span.end)),
            },
          }),
    selectionReasons: unique([item.roleReason, ...item.evidence].filter(Boolean)),
    ...(content === undefined ? {} : { content }),
    metadata: {
      fqName: item.fqName,
      kind: item.kind,
      returnType: parseReturnType(symbol?.signature ?? item.signature ?? ""),
      exported: symbol?.exported ?? null,
      skeletonFallback: fallback,
      applicability: roles.includes("required") ? "EDIT_OR_RULE_OUT" : "INSPECT_SUPPORT",
      targetKind: roles.includes("pivot") ? (roleOrder === 0 ? "lead_pivot" : "hidden_pivot") : "optional_support",
      requiredTargetSources: roles.includes("required")
        ? classifyRequiredTargetSources(item, roleOrder)
        : [],
      ...(item.documentKind === undefined
        ? {}
        : {
            documentKind: item.documentKind,
            evidenceSemantics: ["configuration", "lexical"],
            lineSpans: item.lineSpans ?? [],
            pathClueMatches: item.pathClueMatches ?? [],
          }),
    },
  };
}

function renderStructuralSkeleton(db: Database, filePath: string, symbol: SymbolRecord | undefined): { content?: string; fallback: string } {
  if (!symbol) return { fallback: "metadata_only" };
  const file = getIndexedSkeletonFileResult(db, filePath, "detailed");
  if (!file || file.status !== "ok") return symbol.signature ? { content: symbol.signature, fallback: "signature_only" } : { fallback: "metadata_only" };
  const declaration = file.declarations.find((entry) => entry.name === symbol.localName);
  const member = file.declarations.flatMap((entry) => entry.members).find((entry) => entry.name === symbol.localName);
  const signature = declaration?.signature ?? member?.signature ?? symbol.signature;
  const docstring = declaration?.docstring ?? member?.docstring ?? symbol.docstring;
  const lines = [signature || `${symbol.kind} ${symbol.localName}`];
  if (declaration?.kind === SymbolKind.Class) {
    for (const method of declaration.members.slice(0, 12)) lines.push(`  ${method.signature || method.name}`);
  }
  if (docstring) lines.push(`# ${compact(docstring, 180)}`);
  return { content: lines.join("\n"), fallback: signature ? "full_structural_skeleton" : "metadata_skeleton" };
}

function addActionabilityTargets(hints: readonly { kind: string; sourceFile: string; relatedFile: string; relatedFiles?: string[]; confidence: string; hint: string; evidence: string[] }[], drafts: DraftItem[], nextOrder: () => number): void {
  for (const hint of hints) {
    if (hint.confidence !== "high") continue;
    const related = unique([hint.relatedFile, ...(hint.relatedFiles ?? [])].filter(Boolean));
    for (const relatedFile of related) {
      drafts.push({
        identity: relatedFile,
        roleOrder: nextOrder(),
        path: relatedFile,
        roles: ["required", "support"],
        contentMode: "summary",
        selectionReasons: unique([hint.hint, ...hint.evidence]),
        metadata: { applicability: "EDIT_OR_RULE_OUT", targetKind: hint.kind, sourceFile: hint.sourceFile },
      });
    }
  }
}

function addImpactEvidence(db: Database, repoRoot: string, pivots: readonly CapsuleV2ProductItem[], drafts: DraftItem[], nextOrder: () => number): void {
  let added = 0;
  let impactCharacters = 0;
  for (const pivot of pivots.slice(0, MAX_IMPACT_PIVOTS)) {
    const result = getImpactGraph(db, {
      symbolFqn: pivot.fqName,
      depth: 2,
      format: "list",
      direction: "both",
      maxPaths: 2,
      maxEdges: MAX_IMPACT_EDGES_PER_PIVOT,
      maxTokens: 600,
      includeEvidence: true,
    }, { repoRoot, maxExcerpts: 0 });
    if (!result.ok) continue;
    const relations = result.output.directRelations
      .filter((relation) => relation.direction === "incoming")
      .slice(0, MAX_IMPACT_EDGES_PER_PIVOT);
    for (const relationEvidence of relations) {
      if (added >= MAX_IMPACT_ITEMS) return;
      const dependentId = relationEvidence.source.nodeId;
      const node = result.output.nodes.find((candidate) => candidate.symbolId === dependentId);
      if (!node || node.distance === 0) continue;
      const symbol = listSymbolsByFqName(db, node.fqName)[0];
      const relation = relationEvidence.kind === "calls"
        ? "direct caller"
        : relationEvidence.kind === "imports" || relationEvidence.kind === "re_exports"
          ? "direct importer"
          : relationEvidence.kind === "inherits" || relationEvidence.kind === "implements"
            ? "direct subtype"
            : "direct dependant";
      const sourceLine = relationEvidence.source.lineSpan?.start;
      const content = `${relationEvidence.kind.toUpperCase()} ${node.fqName}${sourceLine === undefined ? "" : ` at ${node.filePath}:${sourceLine}`} [${relationEvidence.strength}]`;
      if (impactCharacters + content.length > MAX_TOTAL_IMPACT_CHARS) return;
      drafts.push({
        identity: `${node.filePath}::${node.fqName}`,
        roleOrder: nextOrder(),
        path: node.filePath,
        symbol: node.localName,
        roles: ["impact"],
        contentMode: "summary",
        ...(symbol ? { lineSpan: { start: symbol.startLine, end: symbol.endLine } } : {}),
        selectionReasons: [`${relation} of ${pivot.fqName}`],
        content,
        metadata: {
          edgeType: relationEvidence.persistedKind,
          relationKind: relationEvidence.kind,
          direction: relationEvidence.direction,
          evidenceStrength: relationEvidence.strength,
          resolutionMethod: relationEvidence.evidence.resolutionMethod,
          evidenceLocationKind: relationEvidence.evidence.locationKind,
          traversalDepth: node.distance,
          pivotFqName: pivot.fqName,
          directRelationCounts: {
            incoming: result.output.richSummary.directIncoming,
            outgoing: result.output.richSummary.directOutgoing,
            byRelation: result.output.richSummary.countsByRelation,
            byStrength: result.output.richSummary.countsByStrength,
          },
          affectedFileCount: result.output.richSummary.affectedFiles,
          strongestPaths: result.output.paths.slice(0, 2).map((path) => ({
            id: path.id,
            direction: path.direction,
            length: path.length,
            minimumStrength: path.minimumStrength,
            nodes: path.nodes.map((pathNode) => pathNode.fqName),
          })),
          testLinks: result.output.tests.map((test) => test.fqName),
          entrypointLinks: result.output.entrypoints.map((entrypoint) => entrypoint.fqName),
          truncated: result.output.richSummary.truncated,
          omittedPaths: result.output.richSummary.omittedPaths,
          omittedEdges: result.output.richSummary.omittedEdges,
          limitations: relationEvidence.limitations,
        },
      });
      added += 1;
      impactCharacters += content.length;
    }
  }
}

function attachStableContextReferences(items: ProductContextItem[]): void {
  const idByFqName = new Map<string, string>();
  for (const item of items) {
    const fqName = typeof item.metadata?.fqName === "string" ? item.metadata.fqName : undefined;
    if (fqName !== undefined) idByFqName.set(fqName, item.id);
  }
  for (const item of items) {
    if (!item.roles.includes("impact")) continue;
    const pivotFqName = typeof item.metadata?.pivotFqName === "string" ? item.metadata.pivotFqName : undefined;
    const pivotContextId = pivotFqName === undefined ? undefined : idByFqName.get(pivotFqName);
    item.metadata = {
      ...(item.metadata ?? {}),
      ...(pivotContextId === undefined ? {} : { pivotContextId, pivotContextReference: `[${pivotContextId}]` }),
      contextId: item.id,
      contextReference: `[${item.id}]`,
    };
  }
}

function addMemoryAndRules(input: AssembleProductContextInput, currentContext: CurrentObservationContext, product: ReturnType<typeof toCapsuleV2ProductResponse>, drafts: DraftItem[], nextOrder: () => number): void {
  const linkedFiles = unique([...product.pivots, ...product.support].map((item) => item.path));
  const memories = searchMemory(input.stores, {
    query: input.task,
    maxResults: MAX_MEMORY_ITEMS * 2,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    linkedFilePaths: linkedFiles,
    currentContext,
  }).filter((result) => (
    result.staleness.status === StaleStateStatus.Fresh
    && !(result.observation.source === "mcp_auto" && result.observation.queryText === input.task)
  )).slice(0, MAX_MEMORY_ITEMS);
  for (const result of memories) {
    drafts.push({
      identity: `memory:${result.observation.id}`,
      roleOrder: nextOrder(),
      roles: ["memory"],
      contentMode: "summary",
      selectionReasons: result.signals.map((signal) => signal.kind),
      content: compact(result.observation.summary, MAX_SUMMARY_CHARS),
      metadata: { source: result.observation.source, type: "memory", createdAtMs: result.observation.createdAtMs, staleness: "fresh" },
    });
  }
  const rules = selectRelevantProjectRules(input.stores.session, {
    repoRoot: input.repoRoot,
    query: input.task,
    intent: product.intent,
    linkedFilePaths: linkedFiles,
    linkedFqNames: [...product.pivots, ...product.support].map((item) => item.fqName),
  }).active.slice(0, MAX_RULE_ITEMS);
  for (const selected of rules) {
    drafts.push({
      identity: `rule:${selected.rule.id}`,
      roleOrder: nextOrder(),
      roles: ["rule"],
      contentMode: "summary",
      selectionReasons: [selected.reason],
      content: compact(selected.rule.summary, MAX_SUMMARY_CHARS),
      metadata: { source: selected.rule.id, type: "rule", updatedAtMs: selected.rule.updatedAtMs, staleness: "fresh" },
    });
  }
}

function deduplicateDrafts(task: string, worktreeId: string, drafts: DraftItem[]): { items: Array<DraftItem & { stableId: string; estimatedTokens: number }>; duplicateItemCountRemoved: number; duplicateCharactersRemoved: number } {
  const byIdentity = new Map<string, DraftItem>();
  let duplicateItemCountRemoved = 0;
  let duplicateCharactersRemoved = 0;
  for (const draft of drafts.sort((a, b) => a.roleOrder - b.roleOrder || a.identity.localeCompare(b.identity))) {
    const existing = byIdentity.get(draft.identity);
    if (!existing) { byIdentity.set(draft.identity, draft); continue; }
    duplicateItemCountRemoved += 1;
    duplicateCharactersRemoved += draft.content?.length ?? 0;
    existing.roles = unique([...existing.roles, ...draft.roles]).sort(roleComparator);
    existing.selectionReasons = unique([...existing.selectionReasons, ...draft.selectionReasons]);
    existing.metadata = { ...(draft.metadata ?? {}), ...(existing.metadata ?? {}) };
    if (!existing.content && draft.content) {
      existing.content = draft.content;
      existing.contentMode = draft.contentMode;
      if (draft.lineSpan) existing.lineSpan = draft.lineSpan;
    }
  }
  const contentOwner = new Map<string, string>();
  for (const draft of byIdentity.values()) {
    if (!draft.content) continue;
    const owner = contentOwner.get(draft.content);
    if (owner === undefined) {
      contentOwner.set(draft.content, draft.identity);
      continue;
    }
    duplicateCharactersRemoved += draft.content.length;
    draft.content = undefined;
    draft.contentMode = "summary";
    draft.metadata = { ...(draft.metadata ?? {}), duplicateBodyOf: owner };
  }
  return {
    items: [...byIdentity.values()].map((draft) => ({
      ...draft,
      roles: [...draft.roles].sort(roleComparator),
      stableId: hash(`${task}\0${worktreeId}\0${draft.identity}`).slice(0, 16),
      estimatedTokens: estimateTokens(renderItem(draft)),
    })),
    duplicateItemCountRemoved,
    duplicateCharactersRemoved,
  };
}

function assignDisplayIds(items: Array<DraftItem & { stableId: string; estimatedTokens: number }>): ProductContextItem[] {
  const counts = new Map<string, number>();
  return items.map(({ identity: _identity, roleOrder: _roleOrder, ...item }) => {
    const prefix = item.roles.includes("pivot") ? "P" : item.roles.includes("required") ? "R" : item.roles.includes("support") ? "S" : item.roles.includes("impact") ? "I" : item.roles.includes("memory") ? "M" : item.roles.includes("rule") ? "G" : "D";
    const ordinal = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, ordinal);
    return { ...item, id: `${prefix}${ordinal}` };
  });
}

function renderModelVisibleContext(task: string, worktreeId: string, intent: string, mode: string, items: ProductContextItem[]): string {
  if (items.length === 0) return "";
  const lines = ["# VTRACE product context", `task: ${task}`, `intent: ${intent}`, `worktree: ${worktreeId}`, `capsule_mode: ${mode}`];
  for (const item of items) {
    lines.push("", `## [${item.id}] ${item.path ?? item.metadata?.type ?? "context"}${item.symbol ? `::${item.symbol}` : ""}`);
    lines.push(`roles: ${item.roles.join(", ")}`, `mode: ${item.contentMode}`);
    if (item.lineSpan) lines.push(`lines: ${item.lineSpan.start}-${item.lineSpan.end}`);
    for (const reason of item.selectionReasons) lines.push(`why: ${reason}`);
    if (item.content) lines.push("", item.content);
  }
  lines.push("", "Impact entries above are bounded static structural evidence; they are not dynamic execution flow.");
  return lines.join("\n");
}

function renderItem(item: Pick<DraftItem, "path" | "symbol" | "roles" | "contentMode" | "selectionReasons" | "content">): string {
  return [item.path ?? "", item.symbol ?? "", item.roles.join(","), item.contentMode, ...item.selectionReasons, item.content ?? ""].join("\n");
}

function buildAccounting(input: { budgetTokens: number; modelVisibleContext: string; naiveTokensEstimate: number | null; duplicateItemCountRemoved: number; duplicateCharactersRemoved: number }): ProductAccounting {
  const used = estimateTokens(input.modelVisibleContext);
  const saved = input.naiveTokensEstimate === null ? null : input.naiveTokensEstimate - used;
  return {
    budgetTokens: input.budgetTokens,
    renderedCharacters: input.modelVisibleContext.length,
    usedTokensEstimate: used,
    naiveTokensEstimate: input.naiveTokensEstimate,
    savedTokensEstimate: saved,
    reductionPercent: input.naiveTokensEstimate && saved !== null ? roundPercent((saved / input.naiveTokensEstimate) * 100) : null,
    remainingTokensEstimate: Math.max(0, input.budgetTokens - used),
    duplicateItemCountRemoved: input.duplicateItemCountRemoved,
    duplicateCharactersRemoved: input.duplicateCharactersRemoved,
    duplicateTokensEstimateRemoved: estimateTokens("x".repeat(input.duplicateCharactersRemoved)),
    estimateMethod: "character_ratio",
    estimateExact: false,
    baseline: PRODUCT_CONTEXT_BASELINE,
    claimBoundary: PRODUCT_CONTEXT_CLAIM_BOUNDARY,
  };
}

async function estimateUniqueFullFiles(repoRoot: string, files: string[]): Promise<number | null> {
  let characters = 0;
  let counted = 0;
  const root = path.resolve(repoRoot);
  for (const file of files) {
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try { characters += (await readFile(absolute, "utf8")).length; counted += 1; } catch { return null; }
  }
  return counted === 0 ? null : estimateTokens("x".repeat(characters));
}

function isRequiredPivot(item: CapsuleV2ProductItem): boolean {
  return !`${item.roleReason} ${item.evidence.join(" ")}`.toLowerCase().includes("low-confidence");
}

function classifyRequiredTargetSources(item: CapsuleV2ProductItem, roleOrder: number): string[] {
  const evidence = `${item.roleReason} ${item.evidence.join(" ")}`.toLowerCase();
  const sources = [roleOrder === 0 ? "lead_pivot" : "hidden_pivot"];
  if (/anchor|traceback|exact path|exact symbol/u.test(evidence)) sources.push("anchored_target");
  if (/co-?edit/u.test(evidence)) sources.push("high_confidence_coedit");
  if (/re-?export|import rescue/u.test(evidence)) sources.push("import_reexport_rescue");
  if (/file evidence|file-level|path evidence/u.test(evidence)) sources.push("file_evidence_rescue");
  return unique(sources);
}

function parseReturnType(signature: string): string | null {
  const python = signature.match(/->\s*([^:]+)\s*:?$/u)?.[1]?.trim();
  if (python) return python;
  return signature.match(/\)\s*:\s*([^={;]+)(?:[={;]|$)/u)?.[1]?.trim() ?? null;
}

function isDocumentationPath(filePath: string): boolean {
  return /(^|\/)(docs?|documentation|examples?)(\/|$)|\.(md|mdx|rst)$/iu.test(filePath);
}

function itemIdentity(item: CapsuleV2ProductItem): string { return `${item.path}::${item.fqName || item.symbol}`; }
function compact(value: string, max: number): string { const text = value.replace(/\s+/gu, " ").trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function elapsed(start: number, end: number): number { return Math.max(0, end - start); }
function roleComparator(a: ProductContextRole, b: ProductContextRole): number { return PRODUCT_CONTEXT_ROLES.indexOf(a) - PRODUCT_CONTEXT_ROLES.indexOf(b); }
