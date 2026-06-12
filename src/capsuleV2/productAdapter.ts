// Capsule v2 product adapter.
//
// Capsule v2 is built by `buildCapsuleV2` for the CLI/Stage-5 surface, where the
// raw `CapsuleV2Result` (internal scorecards, full diagnostics, pivot-ranking
// metadata) is appropriate. The PRODUCT/MCP surface wants a smaller, stable,
// deterministic projection of that result: enough for an agent to act (engine,
// intent, budget, pivots with focused source, support with compact content) plus
// a bounded audit tail (discarded + a diagnostics summary), without leaking the
// internal builder vocabulary or emitting unbounded content.
//
// This module is the single conversion point. `tools.ts` calls
// `toCapsuleV2ProductResponse` and never reaches into `CapsuleV2Result` directly,
// so the MCP response shape can evolve here without spreading v2 formatting logic
// through the tool handlers. It is pure and deterministic: same result in, same
// response out (no clocks, no randomness, no IO).

import {
  CapsuleV2ContentMode,
  type CapsuleV2Discarded,
  type CapsuleV2Item,
  type CapsuleV2Result,
} from "./types";

// Bound on how many discarded candidates the product response carries. The full
// (unbounded) discard list stays available on the raw result / Stage-5 manifest;
// the product surface keeps only the most relevant near-misses so the response
// never balloons on a noisy retrieval. `discardedTotal` records the true count.
const MAX_PRODUCT_DISCARDED = 12;

// Bound on edit-risk directives surfaced (there are at most a couple in practice;
// the cap is a backstop so the product surface stays bounded).
const MAX_PRODUCT_EDIT_RISK_DIRECTIVES = 4;

/** A pivot or support item as the product/MCP surface reports it. */
export interface CapsuleV2ProductItem {
  role: "pivot" | "support";
  path: string;
  /** Local symbol name (e.g. `createSession`). */
  symbol: string;
  /** Fully qualified name (e.g. `session.SessionManager.createSession`). */
  fqName: string;
  kind: string;
  /** The decisive reason this item landed in its role. */
  roleReason: string;
  /** `full` (focused source), `signature`, or `skeleton`. */
  contentMode: string;
  /** Focused source body — present only in `full` content mode. Null otherwise. */
  source: string | null;
  /** Signature / class line when available. Null otherwise. */
  signature: string | null;
  /** Ordered evidence: why this item was selected. */
  evidence: string[];
  /** Estimated token cost of the rendered block. */
  estimatedTokens: number;
  /** True when the item is a docs/examples/fixture file (support at most). */
  isNonSourceExample: boolean;
}

/** Token-budget accounting for the assembled capsule. */
export interface CapsuleV2ProductBudget {
  maxTokens: number;
  estimatedTokens: number;
  usedPercent: number;
}

/** A candidate that did not make the capsule, with the reason it was dropped. */
export interface CapsuleV2ProductDiscarded {
  path: string;
  symbol: string;
  kind: string;
  discardReason: string;
}

/** A deterministic edit-risk / patch-planning hint surfaced to the product. */
export interface CapsuleV2ProductEditRisk {
  kind: string;
  confidence: string;
  directive: string;
}

/** Bounded diagnostics summary — the auditable "why" without the full internals. */
export interface CapsuleV2ProductDiagnostics {
  intentReason: string[];
  intentConfidence: string;
  rolePolicy: string;
  candidateCount: number;
  pivotCount: number;
  supportCount: number;
  discardedCount: number;
  tier: string;
  likelyFiles: string[];
  likelySymbols: string[];
  failingTests: string[];
  editRiskDirectives: CapsuleV2ProductEditRisk[];
}

/**
 * The stable Capsule v2 product response. Self-contained: it carries its own
 * `engine`/`intent` discriminators so a consumer can route on the response alone,
 * independent of any envelope the MCP tool wraps it in.
 */
export interface CapsuleV2ProductResponse {
  engine: "v2";
  /** Capsule v2 is opt-in/experimental on the product surface. */
  experimental: true;
  /** The resolved intent the capsule was built for. */
  intent: string;
  /** Realised sizing tier, or `no_context` when no pivot was found. */
  actualMode: string;
  /** Human-readable reason — present only on the `no_context` path. Null otherwise. */
  reason: string | null;
  budget: CapsuleV2ProductBudget;
  pivots: CapsuleV2ProductItem[];
  support: CapsuleV2ProductItem[];
  /** Bounded near-miss list (see `discardedTotal` for the true count). */
  discarded: CapsuleV2ProductDiscarded[];
  /** Total discarded candidates the engine produced (before the product cap). */
  discardedTotal: number;
  diagnostics: CapsuleV2ProductDiagnostics;
}

function projectItem(item: CapsuleV2Item): CapsuleV2ProductItem {
  return {
    role: item.role,
    path: item.path,
    symbol: item.symbol,
    fqName: item.fq_name,
    kind: item.kind,
    roleReason: item.role_reason,
    contentMode: item.content_mode,
    source: typeof item.source === "string" ? item.source : null,
    signature: typeof item.signature === "string" ? item.signature : null,
    evidence: Array.isArray(item.evidence) ? [...item.evidence] : [],
    estimatedTokens: item.estimated_tokens,
    isNonSourceExample: item.is_non_source_example === true,
  };
}

function projectDiscarded(entry: CapsuleV2Discarded): CapsuleV2ProductDiscarded {
  return {
    path: entry.path,
    symbol: entry.symbol,
    kind: entry.kind,
    discardReason: entry.discard_reason,
  };
}

/**
 * Convert an internal `CapsuleV2Result` into the stable product/MCP response.
 * Pure and deterministic; emits no unbounded content (the source bodies were
 * already budget-bounded by the engine, and the discard/diagnostics tails are
 * capped here).
 */
export function toCapsuleV2ProductResponse(
  result: CapsuleV2Result,
): CapsuleV2ProductResponse {
  const pivots = Array.isArray(result.pivots) ? result.pivots : [];
  const support = Array.isArray(result.support) ? result.support : [];
  const discarded = Array.isArray(result.discarded) ? result.discarded : [];
  const diagnostics = result.diagnostics;
  const editRiskDirectives = Array.isArray(diagnostics.edit_risk_directives)
    ? diagnostics.edit_risk_directives
    : [];

  return {
    engine: "v2",
    experimental: true,
    intent: result.intent,
    actualMode: result.actual_mode,
    reason: typeof result.reason === "string" ? result.reason : null,
    budget: {
      maxTokens: result.budget.max_tokens,
      estimatedTokens: result.budget.estimated_tokens,
      usedPercent: result.budget.used_percent,
    },
    pivots: pivots.map(projectItem),
    support: support.map(projectItem),
    discarded: discarded.slice(0, MAX_PRODUCT_DISCARDED).map(projectDiscarded),
    discardedTotal: discarded.length,
    diagnostics: {
      intentReason: Array.isArray(diagnostics.intent_reason) ? [...diagnostics.intent_reason] : [],
      intentConfidence: diagnostics.intent_confidence,
      rolePolicy: diagnostics.strategy.role_policy,
      candidateCount: diagnostics.candidate_count,
      pivotCount: diagnostics.pivot_count,
      supportCount: diagnostics.support_count,
      discardedCount: diagnostics.discarded_count,
      tier: diagnostics.tier,
      likelyFiles: Array.isArray(diagnostics.likely_files) ? [...diagnostics.likely_files] : [],
      likelySymbols: Array.isArray(diagnostics.likely_symbols) ? [...diagnostics.likely_symbols] : [],
      failingTests: Array.isArray(diagnostics.failing_tests) ? [...diagnostics.failing_tests] : [],
      editRiskDirectives: editRiskDirectives
        .slice(0, MAX_PRODUCT_EDIT_RISK_DIRECTIVES)
        .map((directive) => ({
          kind: directive.kind,
          confidence: directive.confidence,
          directive: directive.directive,
        })),
    },
  };
}

/**
 * The manifest-item identity fields the persistence layer needs to hash + store a
 * capsule manifest. Plain strings (no enum/branded coupling) so it stays
 * structurally compatible with the repository's own manifest-item field shape
 * without either module importing the other's types.
 */
export interface CapsuleV2ManifestItemFields {
  symbolId: string;
  filePath: string;
  fqName: string;
  symbolKind: string;
  role: "pivot" | "support";
  contentMode: string;
  sourceBacked: boolean;
}

/**
 * Project a Capsule v2 result onto ordered manifest-item fields used to persist a
 * capsule manifest (so a follow-up `check_capsule_staleness` resolves against a
 * real store). Pivots first, then support, matching the v1 ordering.
 *
 * Capsule v2 items carry no DB `symbolId` (the v2 pipeline recovers them from the
 * index but does not thread the persisted id onto the product item), so each
 * item's `fqName` is the stable symbol-identity surrogate used for manifest
 * hashing. `sourceBacked` is true only when the full focused source was inlined.
 */
export function capsuleV2ToManifestItemFields(
  result: CapsuleV2Result,
): CapsuleV2ManifestItemFields[] {
  const pivots = Array.isArray(result.pivots) ? result.pivots : [];
  const support = Array.isArray(result.support) ? result.support : [];
  return [...pivots, ...support].map((item) => ({
    symbolId: item.fq_name,
    filePath: item.path,
    fqName: item.fq_name,
    symbolKind: item.kind,
    role: item.role,
    contentMode: item.content_mode,
    sourceBacked: item.content_mode === CapsuleV2ContentMode.Full,
  }));
}
