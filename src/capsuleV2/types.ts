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
  /** Body-literal strength: a task diagnostic code/message found in this symbol's body. */
  body_literal: number;
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
    body_literal: scores.bodyLiteral,
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
  /**
   * True when this item is a non-source example / doc-data / fixture file (docs,
   * examples, sample `bad.py`/`good.py`, etc.). Such a file is never a pivot by
   * default — it is support at most unless the task explicitly points at those
   * areas. Present only when the candidate was classified non-source.
   */
  is_non_source_example?: boolean;
  /** Why the path was treated as non-source (e.g. "path under doc/data"). */
  non_source_reason?: string;
}

/** A candidate that did not make the capsule, with the reason it was dropped. */
export interface CapsuleV2Discarded extends DebugRoleSignals {
  path: string;
  symbol: string;
  kind: string;
  scorecard: CapsuleV2Scorecard;
  evidence: string[];
  discard_reason: string;
  /** See `CapsuleV2Item.is_non_source_example`. Present only when classified. */
  is_non_source_example?: boolean;
  non_source_reason?: string;
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
   * Noise dropped from the high-confidence shaped signals. `filtered_generic_symbols`
   * are generic bug-report words (`error`, `multiple`) that matched a symbol regex
   * but were not allowed to become likely symbols; `filtered_runner_files` are
   * runner/entry scripts (`manage.py`) mentioned only as a command invocation.
   * Present only when something was filtered.
   */
  filtered_generic_symbols?: string[];
  filtered_runner_files?: string[];
  /**
   * Generic-token lexical scoring decomposition of the retrieval query. Generic
   * bug-report tokens present in the query have their lexical contribution
   * down-weighted when they are the ONLY thing matching a candidate's name (so
   * "multiple" cannot make `multiple_chunks` a pivot on its own). Present only when
   * the query carried at least one generic token.
   */
  downweighted_lexical_tokens?: string[];
  lexical_meaningful_token_count?: number;
  lexical_generic_token_count?: number;
  /**
   * Exception-symptom de-anchoring. A CamelCase exception named in the task
   * (`IndexError`, `UnicodeDecodeError`) tokenises into its symptom nouns
   * (`index`, `unicode`, `decode`); on their own those latch retrieval onto
   * symptom-named symbols instead of the cause. When such a noun occurs ONLY
   * inside an exception name (never standalone in the task) it is de-anchored —
   * treated like a generic token for lexical scoring. The full exception name
   * stays in the raw query text, so recall is preserved. Present only when at
   * least one token was de-anchored.
   */
  deanchored_exception_tokens?: string[];
  /**
   * Body-literal recovery. When a distinctive literal cited in the task (a
   * diagnostic/error code, a quoted message) was found in a symbol's SOURCE BODY,
   * that symbol is pulled into the pool — the one signal that reaches a symbol named
   * purely by what it emits. Present only when at least one literal matched.
   */
  body_literal_search_used?: boolean;
  body_literal_matches?: BodyLiteralMatchDiagnostic[];
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
  /**
   * Non-source example / doc-data candidates that were down-ranked OUT of the
   * pivot role (docs/examples/sample files a coincidental lexical hit would
   * otherwise have made an edit target). A production context provider prefers
   * real source; these can be support but not pivots unless the task explicitly
   * points at docs/examples. Present only when at least one was down-ranked.
   */
  non_source_candidates_downranked?: NonSourceDownrankDiagnostic[];
  /**
   * Title-symbol candidate anchoring. The problem TITLE often names the important
   * class/type/symbol while the body lexical decoys dominate ranking; this seeds
   * the index symbols bearing those title names into the candidate pool with
   * direct "title mentions `X`" evidence. Present only when at least one title
   * term resolved to an indexed production symbol.
   */
  title_symbol_search_used?: boolean;
  /** The symbol-shaped terms extracted from the title (present when search ran). */
  title_symbol_terms?: string[];
  /** The production symbols those title terms resolved to. */
  title_symbol_matches?: TitleSymbolMatchDiagnostic[];
  /**
   * High-signal literal / option / acronym anchoring. Complements title-symbol
   * anchoring for misses whose strongest term is not a normal symbol shape — an
   * ALL-CAPS format/acronym (`FITS`, `CDS`), a dunder (`__array_function__`), a
   * CLI/config option (`--ignore-paths`), or a backticked config name. Those terms
   * are resolved to indexed symbols by name / path segment / body literal / config
   * constant and seeded into the pool at title-symbol strength. Present only when at
   * least one high-signal term resolved to an indexed production symbol.
   */
  literal_anchor_search_used?: boolean;
  /** The high-signal terms extracted from the task (present when search ran). */
  literal_anchor_terms?: string[];
  /** The production symbols those literal terms resolved to. */
  literal_anchor_matches?: LiteralAnchorMatchDiagnostic[];
  /**
   * Generic-infrastructure lexical-decoy suppression. A generic bug-report word
   * ("deprecation", "dict", "utils") over-anchors retrieval to an
   * infrastructure/helper module NAMED after that word (`deprecation.py`, a
   * `*Dict*` helper) even when the bug is elsewhere. When such a candidate's whole
   * IDENTITY is a generic infra token, that token is in the query, and it carries
   * no stronger direct evidence (symbol/path/test/body-literal pointer, line
   * anchor, title-symbol match, or strong graph reach) and the task does not name
   * its path, its lexical contribution is weakened so it cannot ride the generic
   * word to a pivot. It is never removed. Present only when at least one candidate
   * was suppressed.
   */
  generic_lexical_decoys_suppressed?: GenericLexicalDecoyDiagnostic[];
}

/** One candidate whose generic-infrastructure lexical match was weakened. */
export interface GenericLexicalDecoyDiagnostic {
  /** The generic infra token responsible (e.g. "deprecation"). */
  token: string;
  path: string;
  /** Why it was treated as a decoy. */
  reason: string;
}

/** One title term resolved to an indexed production symbol. */
export interface TitleSymbolMatchDiagnostic {
  /** The title term that matched (e.g. "PythonCodePrinter"). */
  term: string;
  path: string;
  symbol: string;
}

/** One high-signal literal/option/acronym resolved to an indexed production symbol. */
export interface LiteralAnchorMatchDiagnostic {
  /** The high-signal term that matched (e.g. "FITS", "--ignore-paths"). */
  term: string;
  path: string;
  symbol: string;
}

/** One non-source candidate down-ranked from pivot to support. */
export interface NonSourceDownrankDiagnostic {
  path: string;
  /** Why it was treated as non-source (e.g. "path under doc/data"). */
  reason: string;
}

/**
 * The class of edit risk a directive warns about.
 *
 * `guarded_shared_state_mutation` is the more specific (and higher-precedence)
 * diagnosis: the pivot mutates shared state UNDER A GUARD (`if not X and Y: …
 * X.mutating_call(…)`), so the tempting wrong fix is relaxing the guard rather
 * than cloning before mutation. `shared_state_mutation` is the bare-mutation
 * fallback when no guard is detectable.
 *
 * `chained_lookup_alias_traversal` is a distinct bug class: the pivot validates a
 * chained lookup/path traversal (a loop over split path segments that resolves
 * each segment to a concrete field/target), and the tempting wrong fix is to
 * `continue` past an alias segment (e.g. `pk`) instead of resolving it to its
 * concrete target and updating traversal state.
 *
 * `traversal_state_machine_invariant` is the structural companion to the alias
 * diagnosis: the pivot walks a chained path using a MUTABLE TRAVERSAL CURSOR
 * (`if X.is_relation: cursor = next_target`). Resolving the alias is not enough —
 * every segment must update the cursor for the next segment, and the cursor must
 * be terminated when traversal cannot continue, or later segments validate against
 * stale state. It can render alongside `chained_lookup_alias_traversal` (appended
 * after it for deterministic ordering).
 */
export type EditRiskKind =
  | "shared_state_mutation"
  | "guarded_shared_state_mutation"
  | "chained_lookup_alias_traversal"
  | "traversal_state_machine_invariant";

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

export interface BodyLiteralMatchDiagnostic {
  /** The distinctive literal cited in the task, e.g. `models.E015`. */
  literal: string;
  /** The file whose symbol body contained the literal. */
  path: string;
  /** The symbol (local name) that emits the literal. */
  symbol: string;
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
