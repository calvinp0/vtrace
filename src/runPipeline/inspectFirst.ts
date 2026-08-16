// Inspect-first guidance for the Capsule v2 injected context.
//
// Why this exists: Capsule v2 already pins the right pivots and a ring of support,
// and the pivot-neighborhood pass attaches bounded nearby source. But the
// agent-facing render dumps that evidence verbosely and is not action-oriented:
// the one clean single-shot canary showed the agent received the neighborhood and
// did not act on it. This module produces a short, compact, deterministic
// "inspect-first" summary that names the single most likely first file, at most
// two related-context items, and at most one avoid-first hint — so the likely
// first inspection target is obvious at the top of the context.
//
// This is GUIDANCE, not enforcement: no checklist, no gate, no phase split, no
// tool restriction, no mandatory output format, no patch blocking. It changes no
// retrieval, ranking, scoring, or candidate generation — it is a pure, bounded
// projection of an already-built Capsule v2 product response plus its
// pivot-neighborhood, and it never reaches the v1/default path. Building it never
// throws: any failure degrades to `null` (no section rendered).

import type {
  CapsuleV2ProductItem,
  CapsuleV2ProductResponse,
} from "../capsuleV2/productAdapter";
import type { PivotNeighborhoodContext } from "./pivotNeighborhood";

export type InspectFirstConfidence = "high" | "medium" | "low";

/** One named inspection target with a short, deterministic explanation. */
export interface InspectFirstItem {
  readonly path: string;
  readonly symbol: string | null;
  readonly why: string;
  /** True when this is the traceback/error surface rather than the likely edit site. */
  readonly isSurface: boolean;
}

/** The compact inspect-first guidance projected from a Capsule v2 response. */
export interface InspectFirst {
  readonly confidence: InspectFirstConfidence;
  /** Exactly one likely-first file. */
  readonly likelyFirst: InspectFirstItem;
  /** At most two related-context items. */
  readonly related: readonly InspectFirstItem[];
  /** At most one avoid-first hint, or null. */
  readonly avoidFirst: string | null;
}

// Bounds (Requirement 9). Tight by design so the block stays ~200-500 tokens.
const MAX_RELATED = 2;
const MAX_WHY_CHARS = 180;

// Generic behavior/validation/transform vocabulary. A candidate whose path /
// symbol / role-reason carries these is closer to the behavior, validation, or
// warning logic the fix usually lives in — as opposed to a pure entrypoint or a
// traceback surface. This is a general lexicon, NOT instance-specific rules.
const BEHAVIOR_LEXICON: readonly string[] = [
  "convert", "conversion", "unit", "parse", "format", "render", "transform",
  "encode", "decode", "serialize", "deserialize", "normalize", "validate",
  "validation", "valid", "warn", "deprecat", "sanitize", "compute", "evaluate",
  "escape", "quote", "resolve", "coerce", "cast",
];

// Phrases the role-reason uses to mark a candidate as an actual edit site (vs a
// reachability/context inclusion). Deterministic substring checks over the
// already-rendered role reason; no retrieval signal is recomputed here.
function editSiteSignal(roleReason: string): number {
  const text = roleReason.toLowerCase();
  let score = 0;
  if (text.includes("edit site")) score += 6;
  if (text.includes("root-cause") || text.includes("root cause")) score += 4;
  // The strongest localization signal a role reason carries: the task's own
  // diagnostic/error string was found INSIDE this symbol's body. That is far more
  // specific than a name match or a generic helper, so it outranks them.
  if (text.includes("literal appears in this symbol") || text.includes("task literal")) score += 3;
  // A generic implementation helper (called from many sites) is rarely the bug
  // itself; down-weight it relative to the specific behaviour symbol.
  if (text.includes("implementation helper")) score -= 2;
  return score;
}

function behaviorHits(item: CapsuleV2ProductItem): number {
  const text = `${item.path} ${item.symbol} ${item.fqName} ${item.roleReason} ${item.evidence.join(" ")}`.toLowerCase();
  let hits = 0;
  for (const word of BEHAVIOR_LEXICON) {
    if (text.includes(word)) hits += 1;
  }
  return Math.min(hits, 4);
}

// A try/except wrapper that re-raises is usually the propagation/surface site, not
// the root cause. Detected only from a pivot's inlined source (support carries no
// body), so this never fires on signature-only items. Generic structural signal,
// not an instance rule.
function isPropagationSurface(item: CapsuleV2ProductItem): boolean {
  if (typeof item.source !== "string" || item.source.length === 0) return false;
  return /except\b[\s\S]*\braise\b/.test(item.source);
}

interface ScoredCandidate {
  readonly item: CapsuleV2ProductItem;
  readonly order: number;
  readonly score: number;
  readonly behavior: number;
  readonly surface: boolean;
}

function scoreCandidate(item: CapsuleV2ProductItem, order: number): ScoredCandidate {
  const behavior = behaviorHits(item);
  const surface = isPropagationSurface(item);
  const roleBoost = item.role === "pivot" ? 3 : 1;
  const hasSource = typeof item.source === "string" && item.source.length > 0 ? 2 : 0;
  const score =
    editSiteSignal(item.roleReason)
    + behavior * 2
    + roleBoost
    + hasSource
    - (surface ? 7 : 0);
  return { item, order, score, behavior, surface };
}

// Deterministic ordering: higher score first, then pivots before support, then
// original capsule order, then path. No clocks, no randomness.
function compareScored(left: ScoredCandidate, right: ScoredCandidate): number {
  if (left.score !== right.score) return right.score - left.score;
  const leftPivot = left.item.role === "pivot" ? 0 : 1;
  const rightPivot = right.item.role === "pivot" ? 0 : 1;
  if (leftPivot !== rightPivot) return leftPivot - rightPivot;
  if (left.order !== right.order) return left.order - right.order;
  return left.item.path.localeCompare(right.item.path);
}

// Clean a role-reason / evidence string into a short "why" line: collapse the
// "strong target beyond the pivot budget — " preamble, trim, and bound length.
function shortWhy(item: CapsuleV2ProductItem): string {
  let why = item.roleReason.trim();
  const cutMarkers = ["strong target beyond the pivot budget — ", "strong target beyond the pivot budget - "];
  for (const marker of cutMarkers) {
    if (why.startsWith(marker)) why = why.slice(marker.length);
  }
  if (why.length === 0 && item.evidence.length > 0) why = item.evidence[0]!.trim();
  if (why.length === 0) why = "selected by Capsule v2 retrieval";
  return why.length > MAX_WHY_CHARS ? `${why.slice(0, MAX_WHY_CHARS - 1).trimEnd()}…` : why;
}

function toItem(scored: ScoredCandidate, opts: { surfaceLabel?: boolean } = {}): InspectFirstItem {
  const surface = opts.surfaceLabel === true && scored.surface;
  const why = surface
    ? `where the failure surfaces / re-raises — likely reachability context, not the edit site (${shortWhy(scored.item)})`
    : shortWhy(scored.item);
  return {
    path: scored.item.path,
    symbol: scored.item.symbol.length > 0 ? scored.item.symbol : null,
    why: why.length > MAX_WHY_CHARS ? `${why.slice(0, MAX_WHY_CHARS - 1).trimEnd()}…` : why,
    isSurface: scored.surface,
  };
}

/**
 * Build the compact inspect-first guidance from a Capsule v2 product response and
 * its (optional) pivot-neighborhood. Returns null when there is nothing actionable
 * to point at (no pivots and no support), so the caller omits the section. Pure
 * and deterministic; never throws (a malformed response degrades to null).
 */
export function buildInspectFirst(
  response: CapsuleV2ProductResponse,
  _neighborhood: readonly PivotNeighborhoodContext[] = [],
): InspectFirst | null {
  try {
    const pivots = Array.isArray(response.pivots) ? response.pivots : [];
    const support = Array.isArray(response.support) ? response.support : [];
    const candidates = [...pivots, ...support];
    if (candidates.length === 0) return null;

    const scored = candidates.map((item, index) => scoreCandidate(item, index));
    const ranked = [...scored].sort(compareScored);

    const winner = ranked[0]!;
    const likelyFirst = toItem(winner);

    // Related context: at most two. If the top pivot is a propagation/surface site
    // that did NOT win, force-include it (labeled as surface) so the agent is told
    // the traceback file is reachability context — then fill remaining slots with
    // the next highest-scoring distinct-path candidates.
    const related: InspectFirstItem[] = [];
    const usedPaths = new Set<string>([winner.item.path]);

    const topPivot = scored.find((entry) => entry.item.role === "pivot");
    if (
      topPivot !== undefined
      && topPivot.surface
      && topPivot.item.path !== winner.item.path
      && !usedPaths.has(topPivot.item.path)
    ) {
      related.push(toItem(topPivot, { surfaceLabel: true }));
      usedPaths.add(topPivot.item.path);
    }

    for (const entry of ranked.slice(1)) {
      if (related.length >= MAX_RELATED) break;
      if (usedPaths.has(entry.item.path)) continue;
      related.push(toItem(entry, { surfaceLabel: true }));
      usedPaths.add(entry.item.path);
    }

    // Confidence is honest about how specific the lead signal is.
    const winnerHasEditSignal = editSiteSignal(winner.item.roleReason) > 0;
    let confidence: InspectFirstConfidence;
    if (winnerHasEditSignal && winner.behavior > 0) {
      confidence = "high";
    } else if (winnerHasEditSignal || winner.behavior > 0 || winner.item.role === "pivot") {
      confidence = "medium";
    } else {
      confidence = "low";
    }

    // M154-D. This used to be a constant: every response, at every confidence,
    // told the reader to avoid "broad repository grep/find" before inspecting the
    // targets above. Capsule v2 selects bounded task-relevant evidence and never
    // enumerates a repository, so it has no basis for that instruction — and it is
    // most harmful exactly where it is least supported, on a low-confidence lead
    // for a "does this already exist?" question, where not searching further is how
    // an agent concludes something is missing and writes a second copy of it.
    //
    // What survives is the one avoid-hint the evidence actually supports: a lead
    // that re-raises is where the failure surfaces, not where it is fixed. When
    // nothing in the evidence says "do not start here", nothing is said.
    const avoidFirst = winner.surface
      ? `${formatTarget(likelyFirst)} is where the failure surfaces and re-raises — the fix usually lives further up the call path.`
      : null;

    return { confidence, likelyFirst, related: related.slice(0, MAX_RELATED), avoidFirst };
  } catch {
    return null;
  }
}

/**
 * Render the inspect-first guidance as a compact text block for the injected
 * Capsule v2 context. Returns "" when there is no guidance (null input). The block
 * is explicitly labeled as guidance (not enforcement) and is bounded by
 * `buildInspectFirst`'s caps; this only formats it.
 */
export function renderInspectFirstText(inspect: InspectFirst | null): string {
  if (inspect === null) return "";

  const lines: string[] = [
    // The parenthetical carries the coverage contract in the one place a reader
    // cannot miss it, at no extra line cost: this is a bounded selection, so an
    // absent symbol is unsearched, not absent.
    `## VTRACE inspect-first (guidance from a bounded, non-exhaustive selection; confidence: ${inspect.confidence})`,
    "Likely first file:",
    `- ${formatTarget(inspect.likelyFirst)}`,
    `  Why: ${inspect.likelyFirst.why}`,
    "  Inspect first: this is the closest candidate to the behavior that likely needs editing.",
  ];

  if (inspect.related.length > 0) {
    lines.push("");
    lines.push("Related context:");
    for (const item of inspect.related) {
      lines.push(`- ${formatTarget(item)}`);
      lines.push(`  Why: ${item.why}`);
    }
  }

  if (inspect.avoidFirst !== null) {
    lines.push("");
    lines.push("Avoid first:");
    lines.push(`- ${inspect.avoidFirst}`);
  }

  return lines.join("\n");
}

function formatTarget(item: InspectFirstItem): string {
  return item.symbol !== null ? `${item.path}::${item.symbol}` : item.path;
}
