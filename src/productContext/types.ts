export const PRODUCT_CONTEXT_RESPONSE_VERSION = 2 as const;

export const PRODUCT_CONTEXT_ROLES = [
  "pivot",
  "required",
  "support",
  "skeleton",
  "impact",
  "memory",
  "rule",
  "documentation",
  "configuration",
] as const;

export type ProductContextRole = (typeof PRODUCT_CONTEXT_ROLES)[number];

export type ProductContextContentMode =
  | "focused_source"
  | "full_source"
  | "excerpt"
  | "skeleton"
  | "signature"
  | "summary"
  | "document_excerpt";

export interface ProductContextItem {
  id: string;
  stableId: string;
  path?: string;
  symbol?: string;
  roles: ProductContextRole[];
  contentMode: ProductContextContentMode;
  lineSpan?: { start: number; end: number };
  selectionReasons: string[];
  estimatedTokens: number;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface ProductTiming {
  freshnessMs: number;
  retrievalMs: number;
  capsuleBuildMs: number;
  impactMs: number;
  memoryRulesMs: number;
  renderMs: number;
  totalMs: number;
  indexRefreshMs?: number;
}

export interface ProductAccounting {
  budgetTokens: number | null;
  renderedCharacters: number;
  usedTokensEstimate: number;
  naiveTokensEstimate: number | null;
  savedTokensEstimate: number | null;
  reductionPercent: number | null;
  remainingTokensEstimate: number | null;
  duplicateItemCountRemoved: number;
  duplicateCharactersRemoved: number;
  duplicateTokensEstimateRemoved: number;
  estimateMethod: "character_ratio";
  estimateExact: false;
  baseline: string;
  claimBoundary: string;
}

/**
 * M154-D. What a product-context answer settles, and what it does not.
 *
 * The three fields are constant for this lane on purpose. They are not a
 * measurement; they are the contract, serialized where the consumer can see it,
 * because the failure this exists to prevent is a reader inferring the OPPOSITE
 * from a response that never stated it: taking a bounded, ranked selection for an
 * enumeration, and therefore reading an omission as proof of absence.
 *
 * `absenceClaim` deliberately reuses the workspace evidence vocabulary
 * (`not_observed` / `bounded_absence` / `authoritative_absence`) rather than
 * inventing a parallel one. Ranked retrieval sits at the bottom of that scale —
 * `CAPABILITY_SETTLES_MEMBER_ABSENCE[RankedRetrieval]` is already `false` — so a
 * miss here says nothing about the world. An exact path or symbol lane may prove
 * more; this lane may not, and must never be read as if it had.
 */
export interface ProductContextCoverage {
  /** Bounded, task-ranked selection. Never an enumeration of a repository. */
  mode: "selective_task_retrieval";
  /** What a miss proves: nothing. Ranked retrieval cannot settle absence. */
  absenceClaim: "not_observed";
  /** Always false here. Completeness belongs to the exact lanes, not this one. */
  enumerationComplete: false;
}

export const SELECTIVE_TASK_RETRIEVAL_COVERAGE: ProductContextCoverage = Object.freeze({
  mode: "selective_task_retrieval",
  absenceClaim: "not_observed",
  enumerationComplete: false,
});

export interface ProductContextResponse {
  responseVersion: typeof PRODUCT_CONTEXT_RESPONSE_VERSION;
  resolved: boolean;
  /** What this answer settles. Constant for this lane; see the type. */
  coverage: ProductContextCoverage;
  /** Retrieval and delivery are separate: a hit may still fail to fit. */
  resultState?: "resolved" | "no_result" | "delivery_failure";
  retrievalFound?: boolean;
  deliveryFailed?: boolean;
  topMatchReference?: string;
  delivery?: {
    status: "complete" | "compacted" | "failed" | "no_result";
    selectedItemsBeforeBudget: number;
    deliveredItems: number;
    droppedForBudget: number;
    initialModelTokens: number;
    finalModelTokens: number;
    compactionPasses: number;
    compactionStages: string[];
    excerptsShortened: number;
    skeletonizedItems: number;
    supportDropped: number;
  };
  task: string;
  taskHash: string;
  intent: string;
  capsuleMode: string;
  leadPivot: string | null;
  selectedFileHash: string;
  repository: {
    root: string;
    repositoryId: string;
    worktreeId: string;
    headCommit: string | null;
    branch: string | null;
    detached: boolean;
    indexRunId: number | string | null;
    indexMode: "noop" | "incremental" | "full_rebuild" | null;
    /**
     * Which routing source selected this worktree: an explicit `repo_root`, a
     * client-supplied context root, or the server's bound default. Request-level
     * only — it is never repeated per selected item.
     */
    routingSource?: "explicit_root" | "client_context" | "process_default";
  };
  freshness: {
    status: string;
    reason: string;
    action: string;
    refreshDiagnostics: unknown | null;
  };
  accounting: ProductAccounting;
  timing: ProductTiming;
  roleCounts: Record<ProductContextRole, number>;
  items: ProductContextItem[];
  modelVisibleContext: string;
  diagnostics: {
    staticEvidenceOnly: true;
    limitations: string[];
    selectedFiles: string[];
    requiredFiles: string[];
    supportFiles: string[];
    duplicatePolicy: string;
  };
}
