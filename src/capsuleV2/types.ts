// Capsule v2 — product-facing context capsule types.
//
// Capsule v2 is the bounded, deterministic, graph-native context primitive a
// coding agent consumes for a single task. It is assembled by the pipeline:
//
//   task signals -> intent detection -> candidate generators -> evidence
//   scorecards -> pivot/support/discard roles -> budget allocator -> renderer
//
// These types are the PRODUCT VOCABULARY: the intent surface, the per-candidate
// scorecard (snake_case keys, exactly as a JSON consumer sees them), the role-
// assigned items, and the budget accounting. They are intentionally decoupled
// from the internal capsule builder types so the product surface can evolve
// without churning the retrieval/scoring internals.

import type { HybridScoreComponents } from "../retrieval/hybridScoring";

/**
 * The intent a caller declares for a task. `Auto` is resolved from the task
 * signals into one of the four concrete intents; the rest are explicit.
 */
export enum CapsuleIntent {
  Auto = "auto",
  Debug = "debug",
  Refactor = "refactor",
  Modify = "modify",
  Explain = "explain",
  Impact = "impact",
  TestFailure = "test-failure",
}

/** The concrete intents `Auto` resolves to (never `Auto` itself). */
export type ResolvedCapsuleIntent =
  | CapsuleIntent.Debug
  | CapsuleIntent.Refactor
  | CapsuleIntent.Modify
  | CapsuleIntent.Explain
  | CapsuleIntent.Impact
  | CapsuleIntent.TestFailure;

/** Parse a user-supplied intent string, or undefined if unrecognised. */
export function parseCapsuleIntent(value: string): CapsuleIntent | undefined {
  const normalized = value.trim().toLowerCase();
  for (const intent of Object.values(CapsuleIntent)) {
    if (intent === normalized) {
      return intent;
    }
  }
  // Accept the underscore spelling for ergonomics (test_failure == test-failure).
  if (normalized === "test_failure" || normalized === "testfailure") {
    return CapsuleIntent.TestFailure;
  }
  return undefined;
}

/**
 * The per-candidate scorecard, in the product's snake_case vocabulary. Every
 * value is normalised to [0, 1] WITHIN the candidate pool (except `final`, the
 * weighted sum, which can exceed 1). `centrality` is a tie-breaker/support
 * signal only — it can never make a candidate a pivot on its own.
 */
export interface CapsuleV2Scorecard {
  lexical: number;
  symbol: number;
  path: number;
  test_to_impl: number;
  graph_proximity: number;
  centrality: number;
  actionability: number;
  hub_penalty: number;
  final: number;
}

/** Project the internal hybrid score components onto the product scorecard. */
export function toScorecard(scores: HybridScoreComponents): CapsuleV2Scorecard {
  return {
    lexical: scores.lexical,
    symbol: scores.symbol,
    path: scores.path,
    test_to_impl: scores.testToImpl,
    graph_proximity: scores.graphProximity,
    centrality: scores.centrality,
    actionability: scores.actionability,
    hub_penalty: scores.hubPenalty,
    final: scores.final,
  };
}

/** How a selected item's content is rendered. */
export enum CapsuleV2ContentMode {
  /** Pivot: focused source body — enough to make the edit. */
  Full = "full",
  /** Support (or budget-compressed pivot): signature/class line only. */
  Signature = "signature",
  /** Support with no signature available: skeleton/name only. */
  Skeleton = "skeleton",
}

/**
 * Structural role signals computed by the debug role refinement. They explain
 * WHY a candidate landed in its role beyond the raw scorecard: whether it is an
 * entry-point/caller (delegates to a helper), an implementation helper (does the
 * issue's actual work), or generic external infrastructure (support at most).
 *
 * The last two capture `Class.method` expansion: when the issue names a method
 * that need not exist yet (`ModelAdmin.get_inlines`), the recovered EXISTING
 * methods under that class are the actionable edit sites
 * (`is_class_method_expansion_target`), and the broad containing class is context
 * for them (`is_containing_class_context`), never the primary edit site.
 *
 * The final pair captures the query-builder/SQL-renderer split: for a composed-
 * query SQL-output bug, the public query-construction API
 * (`is_query_builder_entrypoint`, e.g. `QuerySet.values_list`) is the entry point
 * — support — while the compiler/rendering implementation
 * (`is_sql_rendering_implementation`, e.g. `SQLCompiler.get_combinator_sql`) is
 * the actual edit site — a pivot.
 */
export interface DebugRoleSignals {
  is_entry_point: boolean;
  is_implementation_helper: boolean;
  is_generic_infrastructure: boolean;
  is_class_method_expansion_target: boolean;
  is_containing_class_context: boolean;
  is_query_builder_entrypoint: boolean;
  is_sql_rendering_implementation: boolean;
}

export const NO_DEBUG_ROLE_SIGNALS: DebugRoleSignals = Object.freeze({
  is_entry_point: false,
  is_implementation_helper: false,
  is_generic_infrastructure: false,
  is_class_method_expansion_target: false,
  is_containing_class_context: false,
  is_query_builder_entrypoint: false,
  is_sql_rendering_implementation: false,
});

/** A selected pivot or support item, fully rendered and accounted for. */
export interface CapsuleV2Item extends DebugRoleSignals {
  role: "pivot" | "support";
  /** The decisive justification for THIS role (caller vs helper vs infra). */
  role_reason: string;
  path: string;
  fq_name: string;
  symbol: string;
  kind: string;
  content_mode: CapsuleV2ContentMode;
  /** Focused source body (Full mode only). */
  source?: string;
  /** Signature / class line (Signature mode, and carried for Full when present). */
  signature?: string;
  /** Ordered evidence: WHY this item was selected. Never empty. */
  evidence: string[];
  scorecard: CapsuleV2Scorecard;
  estimated_tokens: number;
}

/** A candidate that did not make the capsule, with the reason it was dropped. */
export interface CapsuleV2Discarded extends DebugRoleSignals {
  path: string;
  symbol: string;
  kind: string;
  scorecard: CapsuleV2Scorecard;
  evidence: string[];
  discard_reason: string;
}

/** Token-budget accounting for the assembled capsule. */
export interface CapsuleV2Budget {
  max_tokens: number;
  estimated_tokens: number;
  used_percent: number;
}

/** When the capsule names a real edit target, the allocator's sizing tier. */
export enum CapsuleV2Mode {
  Micro = "micro",
  Standard = "standard",
  Full = "full",
  /** No high-confidence pivot recovered — the capsule is intentionally empty. */
  NoContext = "no_context",
}

/** How confident the intent planner is in the detected intent. */
export type IntentConfidence = "high" | "medium" | "low";

/**
 * The role-assignment strategy an intent selects. This is the MECHANISM the
 * planner controls (not just a label): `debug_refinement` runs the caller/helper/
 * infra refinement + production backfill; the others keep the base role gate.
 */
export type RolePolicy =
  | "debug_refinement"
  | "caller_oriented"
  | "sibling_oriented"
  | "entry_point_oriented";

/** The strategy an intent maps to: what to generate, how to role, how to budget. */
export interface IntentStrategy {
  /** Candidate generators / ranking emphasis this strategy prioritises. */
  candidate_generators: string[];
  /** The role-assignment policy (the planner's real behavioural lever). */
  role_policy: RolePolicy;
  /** Human-readable budget/rendering policy for this strategy. */
  budget_policy: string;
}

export interface CapsuleV2Diagnostics {
  /** Ordered, human-readable signals behind the intent decision. */
  intent_reason: string[];
  /** Planner confidence in the detected intent. */
  intent_confidence: IntentConfidence;
  /** The strategy the detected intent selected (generators / role / budget). */
  strategy: IntentStrategy;
  /** Total candidates the role gate ran over (post-retrieval, pre-roles). */
  candidate_count: number;
  pivot_count: number;
  support_count: number;
  discarded_count: number;
  /** The allocator tier (micro/standard/full) the budget mapped to. */
  tier: CapsuleV2Mode;
  /** The retrieval weights this intent applied, for reproducibility. */
  weights: Record<string, number>;
  /** Shaped query signals (likely files/symbols/failing tests). */
  likely_files: string[];
  likely_symbols: string[];
  failing_tests: string[];
  /**
   * Debug-intent recovery diagnostics (present only under debug intent). They make
   * the production-target recovery auditable: whether the test-only candidate pool
   * triggered a production backfill, the issue subsystem the role refinement
   * inferred, whether a `Class.method` query expansion ran, and whether the
   * dispatcher/helper split fell back to scanning pivot source bodies for calls
   * because the static call graph was missing the edge.
   */
  production_backfill_used?: boolean;
  subsystem_root?: string;
  class_method_expansion_used?: boolean;
  source_body_call_fallback_used?: boolean;
  /**
   * True when the issue described query composition together with SQL
   * rendering/output behaviour, and a SQL-rendering production backfill recovered
   * compiler/renderer candidates (e.g. `SQLCompiler.get_combinator_sql`) the
   * lexical pass — dominated by the public query-builder API — had missed.
   */
  sql_rendering_backfill_used?: boolean;
  /**
   * Present only when `actual_mode === no_context`. For the strongest near-miss
   * candidates, the precise reason each failed the pivot gate — so a conservative
   * no-context decision is never opaque (was it weak parsing, a missing failing
   * test, an over-strict gate, or a candidate generated and then discarded?).
   */
  no_context_explanations?: NoContextExplanation[];
  /**
   * True when the task prose carried a file-line anchor (e.g. `compiler.py#L428-L433`)
   * that resolved to an indexed symbol, which was then promoted as a pivot. Makes
   * the explicit source-anchor route auditable independently of intent.
   */
  line_anchor_resolution_used?: boolean;
  /** The anchors that resolved to a symbol (present only when at least one did). */
  line_anchor_candidates?: LineAnchorDiagnostic[];
  /**
   * Edit-risk / patch-planning hints. Emitted when a selected pivot mutates
   * shared or cloned state (e.g. a query/compiler object) while the task
   * describes composed/combined output — the bug class where simply relaxing an
   * existing guard, rather than cloning before mutation, leaks state across the
   * combined query. Present only when at least one directive fired.
   */
  edit_risk_directives?: EditRiskDirective[];
}

/**
 * The class of edit risk a directive warns about.
 *
 * `guarded_shared_state_mutation` is the more specific (and higher-precedence)
 * diagnosis: the pivot mutates shared state UNDER A GUARD (`if not X and Y: …
 * X.mutating_call(…)`), so the tempting wrong fix is relaxing the guard rather
 * than cloning before mutation. `shared_state_mutation` is the bare-mutation
 * fallback when no guard is detectable.
 */
export type EditRiskKind = "shared_state_mutation" | "guarded_shared_state_mutation";

/** How strongly the trigger signals support the directive. */
export type EditRiskConfidence = "high" | "medium" | "low";

/**
 * A deterministic patch-planning hint. It is emitted when the SHAPE of the
 * selected pivot — not its identity — suggests the bug concerns mutation of
 * shared/aliased state (a query/compiler object mutated in place while a
 * composed/combined result is rendered). The danger is a destructive local edit
 * (relaxing or deleting an existing guard) instead of the correct fix (cloning /
 * copying state before calling a mutating helper). The directive is generic: it
 * names no framework, file, symbol, or patch.
 */
export interface EditRiskDirective {
  kind: EditRiskKind;
  confidence: EditRiskConfidence;
  /** Why this directive fired, in the product's audit vocabulary. */
  reason: string;
  /** The human-readable hint, rendered verbatim near the pivot. */
  directive: string;
}

/** One resolved file-line anchor, as the JSON/diagnostics surface reports it. */
export interface LineAnchorDiagnostic {
  /** The anchor exactly as it appeared in the task, e.g. `compiler.py#L428-L433`. */
  anchor: string;
  /** The indexed file the path hint resolved to. */
  resolved_path: string;
  /** The enclosing (or nearest) indexed symbol the line range mapped to. */
  resolved_symbol: string;
  /** `high` when a symbol span enclosed the range; `low` for a nearest-symbol fallback. */
  confidence: "high" | "low";
}

export interface NoContextExplanation {
  path: string;
  symbol: string;
  /** Why this candidate did not clear the pivot bar. */
  why_not_pivot: string;
}

/** The complete Capsule v2 result — the value the CLI/JSON surface emits. */
export interface CapsuleV2Result {
  intent: ResolvedCapsuleIntent;
  /** Realised mode: a sizing tier, or `no_context` when no pivot was found. */
  actual_mode: CapsuleV2Mode;
  /** Present (and human-readable) only when `actual_mode === no_context`. */
  reason?: string;
  budget: CapsuleV2Budget;
  pivots: CapsuleV2Item[];
  support: CapsuleV2Item[];
  discarded: CapsuleV2Discarded[];
  diagnostics: CapsuleV2Diagnostics;
}
