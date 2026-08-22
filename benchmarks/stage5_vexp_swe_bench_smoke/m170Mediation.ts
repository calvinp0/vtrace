/**
 * M170-C — counterfactual read mediation: window selection, rendering, and the
 * safety verdict for one narrowed operation.
 *
 * The design under test is the only one M170-A's semantics left standing:
 * rewrite the agent's own `Read(file)` into `Read(file, offset, limit)` through
 * the PreToolUse `updatedInput` seam, choosing the window from VTRACE's index.
 *
 * Two structural facts constrain everything here:
 *
 *   1. Read's schema admits exactly ONE contiguous window. A file whose
 *      relevant material sits in two distant places cannot be served by a
 *      narrowing that stays inside the native tool's contract — it can only be
 *      served by widening the window until the saving disappears. This is not a
 *      tuning parameter; it is the shape of the seam.
 *
 *   2. The harness emits its partial-view banner only for whole-file reads over
 *      the token cap. A window supplied through `updatedInput` is not that, so
 *      the narrowing is silent unless a disclosure is added back.
 *
 * PURE. No I/O, no clock, no network.
 */

export interface LineSpan {
  readonly first: number;
  readonly last: number;
}

export interface RankedSpan extends LineSpan {
  readonly fqName: string;
  readonly rank: number;
  /** Span of the outermost symbol enclosing this one, when it has one. */
  readonly scope?: LineSpan;
}

export const WindowPolicy = Object.freeze({
  /** No mediation. The control. */
  Native: "P0_NATIVE",
  /** The single highest-ranked in-file symbol, plus a fixed margin. */
  TopSymbol: "P1_TOP_SYMBOL",
  /**
   * The outermost symbol ENCLOSING the highest-ranked in-file symbol.
   *
   * Exists because of what the django case showed: an issue quotes the method
   * it observed the problem in, retrieval correctly ranks that method first,
   * and the fix lives in a sibling method of the same class. Widening to the
   * declaring scope is the smallest repair that keeps a sibling reachable.
   */
  TopSymbolScope: "P4_TOP_SYMBOL_SCOPE",
  /** Smallest window covering the top-K ranked in-file symbols. */
  CoverTopK: "P2_COVER_TOP_K",
  /** Smallest window covering every ranked in-file symbol. */
  CoverAllRanked: "P3_COVER_ALL_RANKED",
  /**
   * Window centred on the material the agent actually went on to use.
   * NOT IMPLEMENTABLE — it reads the future. It exists to bound what any
   * selector could possibly achieve, so that a poor result can be attributed
   * to the selector or to the seam rather than confused between them.
   */
  Oracle: "PX_ORACLE_UPPER_BOUND",
});
export type WindowPolicy = (typeof WindowPolicy)[keyof typeof WindowPolicy];

/** Frozen before any window was computed. */
export const WINDOW_PARAMETERS = Object.freeze({
  /** Lines of context added on each side of a selected span. */
  marginLines: 20,
  /** K for CoverTopK. */
  topK: 3,
  /**
   * A mediation that would deliver more than this share of the file is not
   * worth its own risk and declines instead — the fail-open rule (§11).
   */
  declineAboveDeliveredShare: 0.75,
  /** Files at or below this many lines are never mediated: nothing to save. */
  minimumFileLines: 120,
});

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function unionSpan(spans: readonly LineSpan[]): LineSpan | null {
  if (spans.length === 0) return null;
  return {
    first: Math.min(...spans.map((s) => s.first)),
    last: Math.max(...spans.map((s) => s.last)),
  };
}

/**
 * Choose the window, or decline.
 *
 * Declining is a first-class outcome, not a failure: §11 requires the native
 * operation to survive untouched whenever VTRACE cannot improve it, and §39
 * requires that path to cost nothing.
 */
export function selectWindow(
  policy: WindowPolicy,
  ranked: readonly RankedSpan[],
  totalLines: number,
  oracle: readonly LineSpan[] = [],
  parameters = WINDOW_PARAMETERS,
): LineSpan | null {
  if (policy === WindowPolicy.Native) return null;
  if (totalLines < parameters.minimumFileLines) return null;

  let base: LineSpan | null = null;
  if (policy === WindowPolicy.Oracle) {
    base = unionSpan(oracle);
  } else if (policy === WindowPolicy.TopSymbol) {
    base = ranked.length === 0 ? null : { first: ranked[0]!.first, last: ranked[0]!.last };
  } else if (policy === WindowPolicy.TopSymbolScope) {
    const top = ranked[0];
    base = top === undefined ? null : (top.scope ?? { first: top.first, last: top.last });
  } else if (policy === WindowPolicy.CoverTopK) {
    base = unionSpan(ranked.slice(0, parameters.topK));
  } else if (policy === WindowPolicy.CoverAllRanked) {
    base = unionSpan(ranked);
  }
  if (base === null) return null;

  const window: LineSpan = {
    first: clamp(base.first - parameters.marginLines, 1, totalLines),
    last: clamp(base.last + parameters.marginLines, 1, totalLines),
  };
  const delivered = (window.last - window.first + 1) / Math.max(1, totalLines);
  if (delivered > parameters.declineAboveDeliveredShare) return null;
  return window;
}

/** Render exactly what Read renders: `cat -n`, tab separator, verbatim content. */
export function renderCatN(lines: readonly string[], window: LineSpan): string {
  const out: string[] = [];
  for (let n = window.first; n <= Math.min(window.last, lines.length); n += 1) {
    out.push(`${n}\t${lines[n - 1] ?? ""}`);
  }
  return out.join("\n");
}

/**
 * The disclosure a narrowed Read must carry, because the harness will not emit
 * one (§23). Worded as the harness words its own, so that the agent reads one
 * contract rather than two.
 */
export function disclosureFor(filePath: string, window: LineSpan, totalLines: number): string {
  return `[Truncated: PARTIAL view — ${filePath}: showing lines ${window.first}-${window.last} of ${totalLines} total. `
    + `Call Read with offset/limit to page through. Do NOT answer from this page alone if the answer may be `
    + `elsewhere in the file.]`;
}

export const MediationVerdict = Object.freeze({
  /** Nothing the agent went on to use fell outside the window. */
  Safe: "SAFE_MEDIATION",
  /** No edit was harmed, but the agent would have needed a further page. */
  RecoverableOverprune: "RECOVERABLE_OVERPRUNE",
  /** An edit the agent authored came from material the window removed. */
  Unsafe: "UNSAFE_MEDIATION",
  /** The mediation declined; the native operation is unchanged. */
  Declined: "DECLINED",
});
export type MediationVerdict = (typeof MediationVerdict)[keyof typeof MediationVerdict];

export interface UsedEvidence {
  /** Anchor line of every edit the agent made to this file after this read. */
  readonly editAnchors: readonly number[];
  /** Spans of every bounded re-read of this file the agent issued after it. */
  readonly rereadSpans: readonly LineSpan[];
}

function covers(window: LineSpan, line: number): boolean {
  return line >= window.first && line <= window.last;
}

function coversSpan(window: LineSpan, span: LineSpan): boolean {
  return span.first >= window.first && span.last <= window.last;
}

/**
 * Classify one mediated operation.
 *
 * An edit anchor is credited as covered when the window contains it OR when a
 * bounded re-read the agent ALSO issued contains it: in the observed trace the
 * agent paged there itself, so the mediation removed nothing it did not fetch
 * back. That credit is the generous reading and it is applied uniformly.
 */
export function classifyMediation(
  window: LineSpan | null,
  used: UsedEvidence,
): MediationVerdict {
  if (window === null) return MediationVerdict.Declined;
  const reachable = (line: number): boolean =>
    covers(window, line) || used.rereadSpans.some((span) => covers(span, line));
  if (used.editAnchors.some((line) => !reachable(line))) return MediationVerdict.Unsafe;
  if (used.rereadSpans.some((span) => !coversSpan(window, span))) return MediationVerdict.RecoverableOverprune;
  return MediationVerdict.Safe;
}
