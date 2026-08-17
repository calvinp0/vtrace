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

import type { ActionabilityHint } from "./actionabilityHints";
import type { LocalizationSignals } from "./localizationSignals";
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
  /** Definition-local capability match; non-zero only for capability lookup intent. */
  direct_answer: number;
  /** M150 bounded behavioural-mechanism evidence; 0 for non-behavioural requests. */
  mechanism_evidence: number;
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
    direct_answer: scores.directAnswerScore ?? 0,
    mechanism_evidence: scores.mechanismEvidence ?? 0,
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
  /** Matched line-bounded configuration/document excerpt. */
  DocumentExcerpt = "document_excerpt",
  /**
   * M150: the bounded real-source region around a decision-bearing statement.
   * Its own mode because it is neither a whole body nor a signature, and calling
   * it either would misdescribe what the reader is being shown (§29).
   */
  MechanismSlice = "mechanism_slice",
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
  /** Present only for truthful file-level document candidates. */
  document_kind?: "yaml" | "toml";
  line_spans?: Array<{ start: number; end: number }>;
  path_clue_matches?: Array<{
    clue: string;
    normalized_clue: string;
    match_type: string;
    score: number;
    subtree_match: boolean;
    filename_match: boolean;
  }>;
  /**
   * True when this item is a non-source example / doc-data / fixture file (docs,
   * examples, sample `bad.py`/`good.py`, etc.). Such a file is never a pivot by
   * default — it is support at most unless the task explicitly points at those
   * areas. Present only when the candidate was classified non-source.
   */
  is_non_source_example?: boolean;
  /** Why the path was treated as non-source (e.g. "path under doc/data"). */
  non_source_reason?: string;
  /**
   * Present only on an item selected for a role beyond its ordinary ranking
   * (M140-C). `orchestration_support` means the item completes an exact short
   * call path whose other nodes are already delivered; it is deliberately NOT a
   * claim that the item ranked well. `ordinary_rank` is the rank it genuinely
   * earned, carried alongside so the two readings stay separable.
   */
  /**
   * M150 `mechanism_support`: this item is not one of the strongest ordinary
   * answer candidates, but it carries the causal evidence needed to interpret an
   * already-selected decision. Deliberately DISTINCT from
   * `orchestration_support`, which means the item completes an exact short call
   * path — merging the two would make both explanations misleading (§30, §64).
   */
  selection_role?: "orchestration_support" | "mechanism_support";
  selection_reason?: string;
  ordinary_rank?: number;
  /** M150: the decision-bearing statement region, when one was delivered. */
  mechanism_slice?: {
    readonly start_line: number;
    readonly end_line: number;
    readonly decision_line: number;
    readonly lines: number;
    readonly bytes: number;
    readonly truncated: boolean;
  };
  /**
   * Pivot-ranking v2 metadata (debug/report only — NOT rendered into the prompt,
   * so it never affects token accounting). Present on pivots when the v2 ranker
   * scored them. `pivot_rank_score` is the explainable ordering key;
   * `pivot_rank_signals`/`pivot_rank_penalties` are the additive deltas behind it.
   */
  pivot_ranking_version?: "legacy" | "v2";
  pivot_rank_score?: number;
  pivot_rank_signals?: string[];
  pivot_rank_penalties?: string[];
  pivot_rank_reason?: string;
}

/** A candidate that did not make the capsule, with the reason it was dropped. */
export interface CapsuleV2Discarded extends DebugRoleSignals {
  path: string;
  symbol: string;
  kind: string;
  scorecard: CapsuleV2Scorecard;
  evidence: string[];
  discard_reason: string;
  /**
   * The CANDIDATE-LOCAL role decision, preserved independently of the reason it
   * was ultimately discarded for. The two answer different questions: a
   * query-global rule can discard a candidate whose own classification was
   * "support", and `discard_reason` alone cannot tell that apart from a
   * candidate that never earned a role at all.
   */
  role_reason?: string;
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
  /** Ordered pre-role candidates with reproducible component attribution. */
  candidate_scores?: CandidateScoreDiagnostic[];
  /** True only when an empty normal hybrid pool used M121 bounded rescue. */
  compound_task_rescue_used?: boolean;
  /** M125 bounded routed-FTS rescue, run only after authoritative selection. */
  routed_rescue?: {
    attempted: boolean;
    reason?: "authoritative_context_sufficient";
    trigger?: "no_candidates" | "missing_exact_identifier" | "missing_path" | "low_compound_coverage";
    missing_clues: string[];
    candidates_added: number;
    selected_candidates_added: number;
    timing_ms: number;
  };
  document_retrieval?: {
    invoked: boolean;
    reason: string;
    query_terms: string[];
    candidate_count: number;
    selected_count: number;
    query_ms: number;
    candidates: Array<{
      path: string;
      kind: "yaml" | "toml";
      raw_rank: number;
      merged_rank: number;
      score: number;
      matched_terms: string[];
      objective_matches: string[];
      line_spans: Array<{ start: number; end: number }>;
      selected: boolean;
      exclusion_reason?: string;
    }>;
  };
  /**
   * M140-C path-completion accounting. Present whenever the upstream rescue lane
   * produced anything to consider, so a request where the role was CONSIDERED and
   * declined is as auditable as one where it fired.
   */
  path_completion?: {
    eligible_request: boolean;
    request_rejected_by?: string;
    discovered_candidates: number;
    eligible_candidates: number;
    selected_count: number;
    rejected: {
      no_intent: number;
      already_selected: number;
      no_coherent_path: number;
      weak_relevance: number;
      structural: number;
      depth: number;
      budget: number;
      slot_taken: number;
    };
    evaluation_ms: number;
    selected?: {
      fq_name: string;
      ordinary_rank: number;
      ordinary_score: number;
      depth: number;
      path: string[];
      coverage_role: string;
      selection_reason: string;
      /** The support entry whose slot it took, when the set was already full. */
      displaced?: string;
      /** False when the slot could not be granted after all (nothing displaceable). */
      applied: boolean;
    };
    candidates: Array<{
      fq_name: string;
      ordinary_rank: number;
      ordinary_score: number;
      depth: number;
      path: string[];
      downstream_selected: number;
      matched_terms: string[];
      eligible: boolean;
      rejected_by?: string;
      selected: boolean;
    }>;
  };
  /** Optional M129 profiler; present only when timing diagnostics are requested. */
  document_integration_profile?: {
    timingsMs: Record<string, number>;
    counters: Record<string, number>;
    documentLane?: {
      attempted: boolean;
      reason: string;
      trigger?: string[];
    };
  };
  /** Non-overlapping M125 clocks; total build remains owned by the caller. */
  stage_timings_ms?: {
    task_derivation: number;
    hybrid_retrieval: number;
  };
  /** Optional M126 request-local hybrid stage profile; absent from stable projections. */
  hybrid_profile?: {
    timingsMs: Record<string, number>;
    counters: Record<string, number>;
  };
  /** Optional M126 post-hybrid stage profile; absent from stable projections. */
  capsule_profile?: {
    timingsMs: Record<string, number>;
    counters: Record<string, number>;
  };
  pivot_count: number;
  support_count: number;
  /**
   * Candidates the role layer classified as SUPPORT that were withheld because
   * no pivot cleared the gate. `support_count` counts what was DELIVERED, so on
   * the no-context path it is legitimately 0 — which left the product unable to
   * distinguish "nothing was relevant" from "relevant context existed and the
   * no-pivot rule dropped it". Present only when that rule actually withheld
   * something.
   */
  support_authority_withheld?: number;
  discarded_count: number;
  /** The allocator tier (micro/standard/full) the budget mapped to. */
  tier: CapsuleV2Mode;
  /** The retrieval weights this intent applied, for reproducibility. */
  weights: Record<string, number>;
  /** Shaped query signals (likely files/symbols/failing tests). */
  likely_files: string[];
  likely_symbols: string[];
  failing_tests: string[];
  /** Compact debug-only view of deterministic task polarity/confidence. */
  query_semantics?: {
    intent: "capability_lookup" | "general";
    intent_reason?: string;
    positive_terms: string[];
    contrast_terms: string[];
    contrast_phrases: string[];
    explicit_identifiers: string[];
    comparison_identifiers: string[];
    weak_literal_tokens: string[];
    symbol_hypotheses: Array<{ text: string; confidence: string; source: string }>;
    project_references: string[];
  };
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
   * M101 anchored-target pivot guard. Present only when the guard changed a
   * role decision: `pivot_selection_version` names the active guard,
   * `anchored_dispatcher_demotions_prevented` lists the tier-2-anchored pivots
   * (title symbol / high-signal literal / strong direct evidence) the
   * entry-point/dispatcher demotion would otherwise have taken, and
   * `anchored_pivot_cap_exemptions` the single anchored pivot kept past the
   * `maxPivots` cap (ordered last among pivots — a required target, never the
   * lead). Weak-direct and support-only lanes are never eligible.
   */
  pivot_selection_version?: string;
  anchored_dispatcher_demotions_prevented?: Array<{ path: string; symbol: string }>;
  anchored_pivot_cap_exemptions?: Array<{ path: string; symbol: string }>;
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
   * Candidates promoted back into a pivot slot that a later demotion vacated.
   * The pivot cap is applied before the scoped-objective and non-source
   * demotions, so a candidate those rules disqualify keeps the slot it consumed
   * and a candidate that met the pivot bar stays demoted behind a budget that is
   * no longer spent. Only candidates already judged pivot-worthy are eligible,
   * and only genuinely free slots are filled. Present only when at least one
   * slot was reclaimed.
   */
  reclaimed_pivot_slots?: Array<{ path: string; symbol: string }>;
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
   * Direct-evidence candidate anchoring (M96). Exact code mentions in the task
   * (dotted module paths, explicit file tokens, file-stem words, mid-sentence
   * class words, mixed-case identifiers) resolved against the index with tight
   * ambiguity caps; resolved symbols already in the pool are boosted, missing
   * ones injected. Present whenever at least one mention was extracted or a
   * generic mention was rejected — so the lane's decisions are always auditable.
   */
  direct_evidence_search_used?: boolean;
  /** Extracted mentions as `type:term` (present when extraction found any). */
  direct_evidence_mentions?: string[];
  /** The indexed production symbols the mentions resolved to. */
  direct_evidence_matches?: DirectEvidenceMatchDiagnostic[];
  /** Mentions dropped because they matched too many indexed files/symbols. */
  direct_evidence_rejected_ambiguous_count?: number;
  /** Mentions dropped by the generic-word stoplist. */
  direct_evidence_rejected_generic_count?: number;
  /** Pool candidates that received the bounded direct-evidence boost. */
  direct_evidence_boosted?: DirectEvidenceBoostDiagnostic[];
  /**
   * Bounded test/import graph-neighbour expansion. The bug report may not name the
   * production edit target, but a high-confidence candidate vtrace already found (a
   * failing test, a config/warning helper, a parser adapter, a sibling module) may
   * import / call / reference it. This walks ONE hop from those high-confidence
   * seeds and seeds the production neighbours as SUPPORT-strength candidates — they
   * can lift top-3 recall but never displace a real pivot. Present only when at
   * least one production neighbour was added.
   */
  graph_neighbor_expansion_used?: boolean;
  /** The seed→neighbour links the expansion added. */
  graph_neighbor_matches?: GraphNeighborMatchDiagnostic[];
  /**
   * Bounded hidden co-edit support expansion (M97). When the capsule leads with a
   * credible source pivot, relation-backed sibling files (edge-connected package
   * neighbours with task-word affinity, generated-artifact pairs, or pooled
   * siblings squeezed out of the support budget) are promoted/injected as
   * SUPPORT-only co-edit candidates — capped, budget-limited, and never able to
   * displace a new-file, non-generic support item or become the lead. Present
   * only when the lane evaluated at least one anchor.
   */
  coedit_lane_fired?: boolean;
  /** The anchor files/symbols the expansion mined from. */
  coedit_anchors?: Array<{ path: string; symbol: string }>;
  /** Selected co-edit candidates (rescued from the pool or freshly injected). */
  coedit_candidates?: CoeditCandidateDiagnostic[];
  /**
   * M98 support precision: LOW-confidence candidates that won a selection slot
   * but were pruned before rendering (single-relation-type rescues, injections
   * without a call edge, injected `__init__` package facades). Diagnostics
   * only — the slot is left empty rather than refilled, so the rendered set is
   * always a subset of what the M97 lane would have shipped.
   */
  coedit_pruned?: CoeditPrunedDiagnostic[];
  /** Count of the above (present only when >0). */
  coedit_pruned_low_confidence_count?: number;
  /** Selection winners by relation-shape confidence tier (high/medium/low). */
  coedit_confidence_tiers?: Record<string, number>;
  /** Medium-confidence co-edit items that found no SPARE support slot and were
   * therefore not rendered (the displacement M98 refuses; they would have
   * displaced a duplicate/generic/docs winner under the M97 placement). */
  coedit_spare_slot_deferred_count?: number;
  /** Hub-shaped rejections: anchors with too many qualifying neighbours, or
   * neighbour files edge-connected to too many distinct files repo-wide. */
  coedit_high_degree_rejected_count?: number;
  /** Neighbours rejected as ambiguous (volume without affinity) or beyond the cap. */
  coedit_ambiguous_rejected_count?: number;
  /** Co-edit items dropped by the per-capsule co-edit token ceiling. */
  coedit_budget_limited_count?: number;
  /** Displaceable support items that lost their slot to a co-edit candidate. */
  coedit_displaced?: Array<{ path: string; symbol: string }>;
  /**
   * Import-re-export rescue instrumentation (M99): pooled support entries with
   * an exact file-level import relation to a co-edit anchor. Kept candidates
   * appear in `coedit_candidates` with evidence type `import_reexport_rescue`
   * and their `import_kinds`.
   */
  coedit_import_considered_count?: number;
  /** Import-relation candidates rejected as edge-fan hubs (M99). */
  coedit_import_hub_rejected_count?: number;
  /** Import-relation candidates rejected by the facade/affinity/capsule-size
   * gates (M99). */
  coedit_import_ambiguous_rejected_count?: number;
  /**
   * File-evidence deep-pool rescue (M100): support-only recovery of a source
   * file the organic generators reach at deep rank (≤100 of a maxResults-400
   * pass) whose raw source text carries an exact, low-ambiguity (≤3 files
   * repo-wide) derived-task evidence term. Present only when the lane
   * extracted at least one mention or was skipped by the distinct-file guard.
   */
  file_evidence_lane_fired?: boolean;
  /** Extracted evidence terms, as `shape:term`. */
  file_evidence_mentions?: string[];
  /** Deep-pool files that passed the cheap gates and were content-tested. */
  file_evidence_considered_count?: number;
  /** Rescued support candidates with their evidence term / ambiguity / rank. */
  file_evidence_candidates?: FileEvidenceCandidateDiagnostic[];
  /** Files whose evidence matched only above the ambiguity cap. */
  file_evidence_ambiguous_rejected_count?: number;
  /** Mentions dropped by the generic-term stoplist. */
  file_evidence_generic_rejected_count?: number;
  /** Files skipped by the content size guard. */
  file_evidence_size_rejected_count?: number;
  /** Qualifying files beyond the per-capsule rescue cap. */
  file_evidence_pruned_count?: number;
  /** Lane skipped because the capsule is already at the distinct-file guard. */
  file_evidence_file_cap_skipped?: boolean;
  /** Rescued items dropped by the file-evidence token ceiling. */
  file_evidence_budget_limited_count?: number;
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
  /**
   * How strongly the issue text itself already localizes the edit site (resolved
   * against the indexed repo). Drives the cost-aware context policy's conservative
   * skip: an already-localized task (traceback frame / explicit file / symbol that
   * resolves) is one a baseline agent localizes for free, so injecting oriented
   * context is net overhead. Derived ONLY from issue text + index — never from
   * gold patches. Always present on a built capsule (including no_context).
   */
  localization_signals?: LocalizationSignals;
}

export interface CandidateScoreDiagnostic {
  rank: number;
  symbol_id: string;
  path: string;
  fq_name: string;
  symbol: string;
  sources: string[];
  evidence: string[];
  scores: HybridScoreComponents;
  identifier_confidence?: string;
}

/** One file rescued by the file-evidence deep-pool lane (M100). */
export interface FileEvidenceCandidateDiagnostic {
  path: string;
  symbol: string;
  /** The exact task term found verbatim in the file's source text. */
  term: string;
  /** The evidence shape the term was extracted as (e.g. "snake_identifier"). */
  shape: string;
  /** Repo-wide count of files containing the term (≤ the ambiguity cap). */
  ambiguity: number;
  /** 1-based symbol rank of the file's best symbol in the deep organic pass. */
  organic_rank: number;
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

/** One exact code mention resolved to an indexed production symbol (M96). */
export interface DirectEvidenceMatchDiagnostic {
  /** The mention that matched (e.g. "utils.numberformat.format", "autoreload"). */
  term: string;
  /** The mention shape ("dotted_module_path", "file_stem_word", ...). */
  type: string;
  /** "strong" (file-resolved, anchor-grade) or "weak" (competitive only). */
  tier: string;
  path: string;
  symbol: string;
}

/** One pool candidate boosted by a direct-evidence mention (M96). */
export interface DirectEvidenceBoostDiagnostic {
  path: string;
  symbol: string;
  tier: string;
}

/** One production neighbour added by bounded graph-neighbour expansion. */
export interface GraphNeighborMatchDiagnostic {
  /** The high-confidence seed the neighbour was reached from. */
  seed_path: string;
  seed_symbol: string;
  /** The edge relation linking seed → neighbour ("imports"/"calls"/"references"/"contains"). */
  edge: string;
  neighbor_path: string;
  neighbor_symbol: string;
  reason: string;
}

/** One selected hidden co-edit candidate (M97 lane), as diagnostics report it. */
export interface CoeditCandidateDiagnostic {
  path: string;
  symbol: string;
  /** "rescued" (already pooled, promoted) or "injected" (fresh candidate). */
  action: string;
  /** Relation evidence class, e.g. "edge_calls_references", "generated_artifact_pair". */
  evidence_type: string;
  /** The anchor file whose relations selected this candidate. */
  anchor_path: string;
  edge_count: number;
  score: number;
  /** Relation-shape confidence tier (M98): "high" | "medium" | "low". */
  confidence: string;
  /** Exact import relation shapes behind an import-relation candidate (M99). */
  import_kinds?: string[];
}

/** A LOW-confidence co-edit selection winner pruned before rendering (M98). */
export interface CoeditPrunedDiagnostic extends CoeditCandidateDiagnostic {
  prune_reason: string;
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
  /**
   * Bounded, evidence-backed reminders that a selected source file likely has a
   * paired generated / co-edit artifact (e.g. a PLY parser table) that must be
   * regenerated or updated alongside the source. Advisory only — derived from the
   * final selection + workspace file map, never from retrieval scoring or gold
   * patches. Present only when at least one hint fired. See `actionabilityHints.ts`.
   */
  actionability_hints?: ActionabilityHint[];
}
