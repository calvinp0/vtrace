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

export interface ProductContextResponse {
  responseVersion: typeof PRODUCT_CONTEXT_RESPONSE_VERSION;
  resolved: boolean;
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
