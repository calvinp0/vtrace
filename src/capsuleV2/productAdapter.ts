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

import type { ActionabilityHint } from "./actionabilityHints";
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

// Bound on actionability hints surfaced. The detector already caps at 3; this is a
// defensive backstop so the product surface stays compact.
const MAX_PRODUCT_ACTIONABILITY_HINTS = 3;

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

/**
 * Role/section counts for the VEXP-shaped first-call summary. `pivot`/`support`/
 * `skeleton` are always present (derived from the capsule's own items);
 * `impact`/`memory`/`rule` are present only when the caller routes those sections
 * in through {@link ToCapsuleV2ProductResponseOptions} (the orchestrator-level
 * seam). They are never fabricated — an absent count means "not supplied", not 0.
 */
export interface CapsuleV2ProductSummary {
  pivotCount: number;
  supportCount: number;
  /** Items rendered without full source (signature/skeleton) — the skeletonized scaffolding. */
  skeletonCount: number;
  impactCount?: number;
  memoryCount?: number;
  ruleCount?: number;
}

/**
 * One representative impact relationship — a real graph dependent/caller the
 * agent should sanity-check for a co-edit. Path/symbol/line spans come straight
 * from the indexed impact graph; `snippet` is present ONLY when the caller layer
 * loaded a real source excerpt. When no snippet is available the line is rendered
 * with `snippetUnavailableReason` and never a fabricated body.
 */
export interface CapsuleV2DigestImpactItem {
  role: "caller" | "importer" | "dependent" | "reference";
  path: string;
  symbol?: string;
  lineStart?: number;
  lineEnd?: number;
  snippet?: string;
  snippetUnavailableReason?: string;
  why?: string;
}

/**
 * Optional impact summary the caller can fold into the digest/summary. VTRACE
 * exposes impact as graph-summary counts (and real dependent identities); it does
 * NOT carry per-caller source snippets on the run_pipeline path, so
 * `snippetsAvailable` is honestly `false` until edge source-span extraction lands.
 */
export interface CapsuleV2DigestImpactSeam {
  dependentCount: number;
  /** Distinct files containing dependents (the blast-radius file count). */
  crossFileDependentCount?: number;
  /** Direct caller count when the caller separates callers from other dependents. */
  callerCount?: number;
  /** Direct importer count when available. */
  importerCount?: number;
  /** False (default) when only the dependency summary is available, not snippets. */
  snippetsAvailable?: boolean;
  /** False when the impact section was attempted but produced nothing. */
  available?: boolean;
  /** Bounded representative dependents (real graph identities; never fabricated). */
  representative?: CapsuleV2DigestImpactItem[];
}

/** One surfaced memory observation (already relevance-selected upstream). */
export interface CapsuleV2DigestMemoryItem {
  source: "session" | "durable" | "rule" | "unknown";
  /** Human age string when the caller has a clock; omitted by pure/offline callers. */
  age?: string;
  text: string;
  stale?: boolean;
  why?: string;
}

/** Optional memory summary (session + durable counts) the caller can fold in. */
export interface CapsuleV2DigestMemorySeam {
  sessionCount: number;
  durableCount: number;
  /** Stale observations among the surfaced set, when the caller computes staleness. */
  staleCount?: number;
  available?: boolean;
  /** Bounded representative observations (already-selected relevant memories). */
  items?: CapsuleV2DigestMemoryItem[];
}

/** One surfaced active project rule (already relevance-selected upstream). */
export interface CapsuleV2DigestRuleItem {
  title?: string;
  text: string;
  source?: string;
  why?: string;
}

/** Optional project-rules summary the caller can fold in. */
export interface CapsuleV2DigestRulesSeam {
  activeCount: number;
  available?: boolean;
  /** Bounded representative active rules (already-selected relevant rules). */
  items?: CapsuleV2DigestRuleItem[];
}

/**
 * Caller-supplied context for the product projection. Every field is optional so
 * the adapter stays a drop-in for its CLI / benchmark / orchestrator / MCP callers;
 * the defaults produce a self-contained pivot/support digest with no fabricated
 * impact/memory/rules data.
 */
export interface ToCapsuleV2ProductResponseOptions {
  /** The task/query the capsule was built for (rendered as the digest header). */
  query?: string;
  /** Impact summary seam — folds a `→ impact` line + `impactCount` in when present. */
  impact?: CapsuleV2DigestImpactSeam | null;
  /** Memory summary seam — folds a `◎ memory` line + `memoryCount` in when present. */
  memory?: CapsuleV2DigestMemorySeam | null;
  /** Project-rules summary seam — folds a `◇ rule` line + `ruleCount` in when present. */
  rules?: CapsuleV2DigestRulesSeam | null;
  /** Additional honest warnings to merge into `warnings` (deduped, order-stable). */
  warnings?: string[];
  /**
   * Defensible saved-token estimate for the digest budget line. Omitted by the
   * pure callers (the file-read baseline is computed at the MCP/CLI envelope, not
   * here); supplied only when a caller already has a defensible figure.
   */
  savedTokensEstimate?: number | null;
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

/** The stable, unversioned product capsule response. */
export interface CapsuleV2ProductResponse {
  /** The task/query the capsule was built for (empty string when not supplied). */
  query: string;
  /** The resolved intent the capsule was built for. */
  intent: string;
  /** Realised sizing tier, or `no_context` when no pivot was found. */
  actualMode: string;
  /** Human-readable reason — present only on the `no_context` path. Null otherwise. */
  reason: string | null;
  budget: CapsuleV2ProductBudget;
  /** Role/section counts for the VEXP-shaped first-call summary. */
  summary: CapsuleV2ProductSummary;
  pivots: CapsuleV2ProductItem[];
  support: CapsuleV2ProductItem[];
  /**
   * Honest unavailable-data / bounded-content markers. Never fabricated — e.g.
   * `no_pivot_recovered`, `pivot_source_bounded_to_signatures`,
   * `impact_snippets_unavailable`. Empty when nothing notable.
   */
  warnings: string[];
  /**
   * Compact, deterministic agent-facing render of the capsule using stable role
   * glyphs (`●` pivot, `○` skel, `→` impact, `◎` memory, `◇` rule) with a `why:`
   * line per item and a closing budget line. Pure: carries no latency/clock data.
   */
  digest: string;
  /** Bounded near-miss list (see `discardedTotal` for the true count). */
  discarded: CapsuleV2ProductDiscarded[];
  /** Total discarded candidates the engine produced (before the product cap). */
  discardedTotal: number;
  diagnostics: CapsuleV2ProductDiagnostics;
  /**
   * Bounded, evidence-backed reminders that a selected source file likely has a
   * paired generated / co-edit artifact (e.g. a PLY parser table) the agent must
   * regenerate or update alongside its edit. Advisory only; never derived from
   * retrieval scoring or gold patches. Always present (empty when none fired).
   */
  actionabilityHints: ActionabilityHint[];
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

// How many items per group (pivots, support) the digest spells out before
// collapsing the tail into a `…(+N more)` line, so the render stays bounded on a
// noisy capsule. The structured `pivots`/`support` arrays still carry every item.
const MAX_DIGEST_ITEMS_PER_GROUP = 6;

// How many representative impact / memory / rule rows the digest spells out. The
// header counts still report the true totals; these caps only bound the inline
// preview so the enriched digest stays compact.
const MAX_DIGEST_IMPACT_ITEMS = 3;
const MAX_DIGEST_MEMORY_ITEMS = 3;
const MAX_DIGEST_RULE_ITEMS = 3;

// Single-line length cap for any folded-in free text (memory body, rule text,
// impact snippet) so one verbose row can't blow the digest budget.
const MAX_DIGEST_TEXT_CHARS = 100;

/** Collapse whitespace/newlines to a single line and truncate to a hard cap. */
function compactDigestText(text: string, max = MAX_DIGEST_TEXT_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

// --- Digest header (query) compaction -------------------------------------------
//
// The digest header line `# <query>` echoes the task/query the capsule was built
// for. For a navigation MCP call that query is a short phrase, but a Stage-5
// SWE-bench task carries the FULL issue/problem statement (up to the harness query
// cap), so a verbatim header can be multiple thousand chars — large enough to crowd
// out the (bounded) decision contract under the atomic context budget, which is
// exactly what forced M62's three fail-closed cases. The digest is an action map,
// and the agent already receives the full problem statement through the harness
// prompt, so the header only needs a compact label plus a bounded, deterministic
// excerpt — never the whole issue body.
//
// Cap rationale (800 chars): the M61B/M62 size accounting showed every
// non-pathological task's title+lead sits well under 800, while the three M62
// fail-closed headers were ~8,000 chars; capping the verbatim query at 800 keeps
// the header from ever dominating the 12,000-char structured budget. Head/tail
// excerpting (500 + 200) preserves the issue's opening framing and its closing ask
// (reproduction / expected-vs-actual typically live at the head and tail). Pure and
// deterministic: no clock, no model summarization, identical output across calls.
export const MAX_DIGEST_QUERY_CHARS = 800;
const DIGEST_QUERY_HEAD_CHARS = 500;
const DIGEST_QUERY_TAIL_CHARS = 200;

/** Result of {@link compactDigestHeader}: the header lines plus size accounting. */
export interface CompactedDigestHeader {
  /** The digest header lines to emit (join with "\n"); empty when query is blank. */
  readonly lines: string[];
  /** True when the query exceeded the cap and was excerpted. */
  readonly truncated: boolean;
  /** Length of the trimmed query (the value emitted as `query_original_chars`). */
  readonly queryChars: number;
  /** Length of the rendered header block (lines joined by "\n"). */
  readonly renderedChars: number;
}

/**
 * Deterministically render the digest header for a query. Short queries
 * (≤ {@link MAX_DIGEST_QUERY_CHARS}) render byte-identically to the legacy
 * `# <query>` line. Longer queries are compacted to a bounded first-line label
 * plus a deterministic head/tail excerpt, an explicit `query_truncated: true`
 * marker, and the original char count — no model summarization, fully pure.
 */
export function compactDigestHeader(rawQuery: string): CompactedDigestHeader {
  const query = rawQuery.trim();
  if (query.length === 0) {
    return { lines: [], truncated: false, queryChars: 0, renderedChars: 0 };
  }
  if (query.length <= MAX_DIGEST_QUERY_CHARS) {
    const lines = [`# ${query}`];
    return { lines, truncated: false, queryChars: query.length, renderedChars: lines.join("\n").length };
  }
  const firstLine = query.split("\n").find((line) => line.trim().length > 0) ?? query;
  const title = compactDigestText(firstLine);
  const head = query.slice(0, DIGEST_QUERY_HEAD_CHARS).replace(/\s+/g, " ").trim();
  const tail = query.slice(query.length - DIGEST_QUERY_TAIL_CHARS).replace(/\s+/g, " ").trim();
  const lines = [
    `# ${title}`,
    `query_excerpt: ${head} … ${tail}`,
    "query_truncated: true",
    `query_original_chars: ${query.length}`,
  ];
  return { lines, truncated: true, queryChars: query.length, renderedChars: lines.join("\n").length };
}

/** `path::symbol` when a symbol is known, else just the path. */
function impactItemTarget(item: CapsuleV2DigestImpactItem): string {
  const symbol = typeof item.symbol === "string" ? item.symbol.trim() : "";
  return symbol.length > 0 ? `${item.path}::${symbol}` : item.path;
}

/** ` Lx-Ly` line range when both endpoints are known, else "". */
function impactItemLineRange(item: CapsuleV2DigestImpactItem): string {
  if (typeof item.lineStart === "number" && typeof item.lineEnd === "number") {
    return ` L${item.lineStart}-L${item.lineEnd}`;
  }
  if (typeof item.lineStart === "number") {
    return ` L${item.lineStart}`;
  }
  return "";
}

/**
 * Render the `→ impact` block: a header line carrying the real dependent/cross-file/
 * caller counts, then up to {@link MAX_DIGEST_IMPACT_ITEMS} representative rows.
 * A row gets a `: <snippet>` suffix ONLY when a real snippet was supplied; otherwise
 * it carries the bare (real) identity plus an optional `why:` — never an invented body.
 */
function renderImpactBlock(impact: CapsuleV2DigestImpactSeam): string[] {
  if (impact.available === false) {
    return ["→ impact unavailable"];
  }
  const parts = [`${impact.dependentCount} dependents`];
  if (typeof impact.crossFileDependentCount === "number") {
    parts.push(`${impact.crossFileDependentCount} cross-file`);
  }
  if (typeof impact.callerCount === "number") {
    parts.push(`${impact.callerCount} callers`);
  }
  const representative = Array.isArray(impact.representative) ? impact.representative : [];
  const snippetsAvailable = impact.snippetsAvailable === true;
  const headerSuffix = snippetsAvailable || representative.length > 0
    ? ""
    : " (summary only — snippets unavailable)";
  const lines = [`→ impact ${parts.join(", ")}${headerSuffix}`];
  for (const item of representative.slice(0, MAX_DIGEST_IMPACT_ITEMS)) {
    let line = `    ${item.role} ${impactItemTarget(item)}${impactItemLineRange(item)}`;
    if (typeof item.snippet === "string" && item.snippet.trim().length > 0) {
      line += `: ${compactDigestText(item.snippet)}`;
    }
    lines.push(line);
    const why = typeof item.why === "string" && item.why.trim().length > 0
      ? item.why.trim()
      : (typeof item.snippet === "string" && item.snippet.trim().length > 0
          ? null
          : "likely co-edit / blast-radius check");
    if (why !== null) {
      lines.push(`        why: ${why}`);
    }
  }
  return lines;
}

/** Render the `◎ memory` block: session/durable/stale counts + bounded observations. */
function renderMemoryBlock(memory: CapsuleV2DigestMemorySeam): string[] {
  if (memory.available === false) {
    return ["◎ memory unavailable"];
  }
  const parts = [`${memory.sessionCount} session`, `${memory.durableCount} durable`];
  if (typeof memory.staleCount === "number" && memory.staleCount > 0) {
    parts.push(`${memory.staleCount} stale`);
  }
  const lines = [`◎ memory ${parts.join(", ")}`];
  const items = Array.isArray(memory.items) ? memory.items : [];
  for (const item of items.slice(0, MAX_DIGEST_MEMORY_ITEMS)) {
    const tag = typeof item.age === "string" && item.age.trim().length > 0
      ? ` (${item.age.trim()})`
      : "";
    const staleMark = item.stale === true ? " [stale]" : "";
    lines.push(`    ${item.source}${tag}${staleMark}: ${compactDigestText(item.text)}`);
  }
  return lines;
}

/** Render the `◇ rule` block: active count + bounded rule previews. */
function renderRulesBlock(rules: CapsuleV2DigestRulesSeam): string[] {
  if (rules.available === false) {
    return ["◇ rules unavailable"];
  }
  const lines = [`◇ rule ${rules.activeCount} active`];
  const items = Array.isArray(rules.items) ? rules.items : [];
  for (const item of items.slice(0, MAX_DIGEST_RULE_ITEMS)) {
    const title = typeof item.title === "string" && item.title.trim().length > 0
      ? `${item.title.trim()}: `
      : "";
    lines.push(`    ${title}${compactDigestText(item.text)}`);
  }
  return lines;
}

/** The stable target identity used in the digest: fqName, else `path::symbol`, else path. */
function digestTarget(item: CapsuleV2ProductItem): string {
  if (typeof item.fqName === "string" && item.fqName.trim().length > 0) {
    return item.fqName;
  }
  const symbol = typeof item.symbol === "string" ? item.symbol.trim() : "";
  return symbol.length > 0 ? `${item.path}::${symbol}` : item.path;
}

/** The `[mode ~Nt]` content tag, e.g. `[full ~40t]` / `[signature ~12t]`. */
function digestContentTag(item: CapsuleV2ProductItem): string {
  const mode = item.contentMode;
  return Number.isFinite(item.estimatedTokens)
    ? `[${mode} ~${item.estimatedTokens}t]`
    : `[${mode}]`;
}

/** One item's digest lines: the glyph line plus an indented `why:` line when known. */
function digestItemLines(
  glyph: string,
  label: string,
  item: CapsuleV2ProductItem,
): string[] {
  const lines = [`${glyph} ${label} ${digestTarget(item)}  ${digestContentTag(item)}`];
  const why = item.evidence.length > 0 ? item.evidence[0] : item.roleReason;
  if (typeof why === "string" && why.trim().length > 0) {
    lines.push(`    why: ${why.trim()}`);
  }
  return lines;
}

/** The closing budget/accounting line; appends a saved-token clause only when defensible. */
function digestBudgetLine(
  budget: CapsuleV2ProductBudget,
  savedTokensEstimate: number | null | undefined,
): string {
  let line = `budget: ${budget.estimatedTokens}/${budget.maxTokens}t (${budget.usedPercent}%)`;
  if (typeof savedTokensEstimate === "number" && savedTokensEstimate > 0) {
    line += `  saved≈${savedTokensEstimate}t vs full-file`;
  }
  return line;
}

/**
 * Render the compact, deterministic VEXP-shaped digest. Pure: it touches no clock
 * and fabricates nothing — impact/memory/rules lines appear only when the caller
 * routes those seams in, and an unavailable seam renders an explicit
 * `unavailable` marker rather than an invented count.
 */
function renderCapsuleV2Digest(input: {
  query: string;
  actualMode: string;
  reason: string | null;
  pivots: CapsuleV2ProductItem[];
  support: CapsuleV2ProductItem[];
  budget: CapsuleV2ProductBudget;
  impact?: CapsuleV2DigestImpactSeam | null;
  memory?: CapsuleV2DigestMemorySeam | null;
  rules?: CapsuleV2DigestRulesSeam | null;
  savedTokensEstimate?: number | null;
}): string {
  const lines: string[] = [];
  lines.push(...compactDigestHeader(input.query).lines);

  if (input.actualMode === "no_context" || (input.pivots.length === 0 && input.support.length === 0)) {
    lines.push("(no high-confidence pivot recovered)");
    if (typeof input.reason === "string" && input.reason.trim().length > 0) {
      lines.push(`reason: ${input.reason.trim()}`);
    }
  } else {
    const pivotsShown = input.pivots.slice(0, MAX_DIGEST_ITEMS_PER_GROUP);
    for (const pivot of pivotsShown) {
      lines.push(...digestItemLines("●", "pivot", pivot));
    }
    if (input.pivots.length > pivotsShown.length) {
      lines.push(`  …(+${input.pivots.length - pivotsShown.length} more pivots)`);
    }
    const supportShown = input.support.slice(0, MAX_DIGEST_ITEMS_PER_GROUP);
    for (const item of supportShown) {
      lines.push(...digestItemLines("○", "skel", item));
    }
    if (input.support.length > supportShown.length) {
      lines.push(`  …(+${input.support.length - supportShown.length} more support)`);
    }
  }

  if (input.impact) {
    lines.push(...renderImpactBlock(input.impact));
  }
  if (input.memory) {
    lines.push(...renderMemoryBlock(input.memory));
  }
  if (input.rules) {
    lines.push(...renderRulesBlock(input.rules));
  }

  lines.push(digestBudgetLine(input.budget, input.savedTokensEstimate));
  return lines.join("\n");
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
  options: ToCapsuleV2ProductResponseOptions = {},
): CapsuleV2ProductResponse {
  const rawPivots = Array.isArray(result.pivots) ? result.pivots : [];
  const rawSupport = Array.isArray(result.support) ? result.support : [];
  const discarded = Array.isArray(result.discarded) ? result.discarded : [];
  const diagnostics = result.diagnostics;
  const editRiskDirectives = Array.isArray(diagnostics.edit_risk_directives)
    ? diagnostics.edit_risk_directives
    : [];
  const actionabilityHints = Array.isArray(result.actionability_hints)
    ? result.actionability_hints
    : [];

  const pivots = rawPivots.map(projectItem);
  const support = rawSupport.map(projectItem);
  const budget: CapsuleV2ProductBudget = {
    maxTokens: result.budget.max_tokens,
    estimatedTokens: result.budget.estimated_tokens,
    usedPercent: result.budget.used_percent,
  };
  const query = typeof options.query === "string" ? options.query : "";
  const reason = typeof result.reason === "string" ? result.reason : null;
  const impact = options.impact ?? null;
  const memory = options.memory ?? null;
  const rules = options.rules ?? null;

  // Section counts. pivot/support/skeleton come from the capsule's own items;
  // skeletonCount is the skeletonized scaffolding (anything not rendered as full
  // source). impact/memory/rule counts are present only when their seam was routed
  // in — an absent count means "not supplied", never a fabricated 0.
  const skeletonCount = [...pivots, ...support].filter(
    (item) => item.contentMode !== CapsuleV2ContentMode.Full,
  ).length;
  const summary: CapsuleV2ProductSummary = {
    pivotCount: pivots.length,
    supportCount: support.length,
    skeletonCount,
    ...(impact ? { impactCount: impact.dependentCount } : {}),
    ...(memory ? { memoryCount: memory.sessionCount + memory.durableCount } : {}),
    ...(rules ? { ruleCount: rules.activeCount } : {}),
  };

  // Honest, deduped, order-stable warnings. Derived from the capsule itself plus
  // any routed-in unavailability, then merged with caller-supplied warnings.
  const warnings: string[] = [];
  const addWarning = (warning: string): void => {
    if (warning.length > 0 && !warnings.includes(warning)) {
      warnings.push(warning);
    }
  };
  if (result.actual_mode === "no_context") {
    addWarning("no_pivot_recovered");
  }
  if (pivots.length > 0 && pivots.every((item) => item.contentMode !== CapsuleV2ContentMode.Full)) {
    addWarning("pivot_source_bounded_to_signatures");
  }
  if (impact && impact.available === false) {
    addWarning("impact_unavailable");
  } else if (impact && impact.snippetsAvailable !== true) {
    addWarning("impact_snippets_unavailable");
  }
  if (memory && memory.available === false) {
    addWarning("memory_unavailable");
  }
  if (rules && rules.available === false) {
    addWarning("rules_unavailable");
  }
  for (const warning of options.warnings ?? []) {
    if (typeof warning === "string") {
      addWarning(warning);
    }
  }

  const digest = renderCapsuleV2Digest({
    query,
    actualMode: result.actual_mode,
    reason,
    pivots,
    support,
    budget,
    impact,
    memory,
    rules,
    savedTokensEstimate: options.savedTokensEstimate ?? null,
  });

  return {
    query,
    intent: result.intent,
    actualMode: result.actual_mode,
    reason,
    budget,
    summary,
    pivots,
    support,
    warnings,
    digest,
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
    actionabilityHints: actionabilityHints
      .slice(0, MAX_PRODUCT_ACTIONABILITY_HINTS)
      .map((hint) => ({
        kind: hint.kind,
        sourceFile: hint.sourceFile,
        relatedFile: hint.relatedFile,
        // The full co-edit candidate set (multi_file_coedit only). Passed through so
        // the product/MCP surface preserves every related file, not just the first.
        ...(Array.isArray(hint.relatedFiles) ? { relatedFiles: [...hint.relatedFiles] } : {}),
        confidence: hint.confidence,
        evidence: Array.isArray(hint.evidence) ? [...hint.evidence] : [],
        hint: hint.hint,
        ...(hint.patchObligation
          ? {
              patchObligation: {
                kind: hint.patchObligation.kind,
                text: hint.patchObligation.text,
              },
            }
          : {}),
      })),
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
