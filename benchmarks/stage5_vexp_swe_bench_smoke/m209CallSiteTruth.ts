/**
 * M209 — call-site truth: the rules that decide whether a rendered impact
 * relation is EVIDENCE or a claim dressed as evidence.
 *
 * PURE. Nothing here reads a database or a file; every function takes the
 * relation as the product delivered it, the caller's indexed span, the file's
 * indexed identity, and the file as it stands on disk, and answers one
 * question about them. The audit driver and the falsification suite both call
 * these so that a control asserts the RULE and not one run's output.
 *
 * The frozen A15 predicate is NOT restated here. `frozenA15Rendered` delegates
 * to `callSiteIsRendered` in m197aScoring.ts, byte-for-byte the committed
 * scorer, so the audit counts with the rule the verdict is decided by. The
 * truth guard below is STRICTER than the frozen rule on purpose: the scorer
 * asks whether the text names the callee; the guard asks whether the text is
 * the file's own line at the declared span. A relation can satisfy the scorer
 * with an invented line that happens to contain the callee's name, and that is
 * exactly the dishonesty F3 exists to catch.
 */
import { callSiteIsRendered } from "./m197aScoring";

// --------------------------------------------------------------- shapes

/** The product's evidence block, as delivered on any surface or by the core. */
export interface RelationEvidenceLike {
  readonly sourceText?: string;
  readonly referenceName?: string;
  readonly resolutionMethod?: string;
  readonly locationKind?: string;
  readonly callSites?: readonly { readonly startLine: number; readonly endLine: number; readonly precision?: string }[];
  readonly callSiteCount?: number;
}

export interface RelationLike {
  readonly id?: string;
  readonly edgeId?: string | null;
  readonly kind?: string;
  readonly direction?: string;
  readonly strength?: string;
  readonly source?: { readonly path?: string; readonly symbol?: string; readonly nodeId?: string; readonly lineSpan?: { start: number; end: number } };
  readonly target?: { readonly path?: string; readonly symbol?: string; readonly nodeId?: string };
  readonly evidence?: RelationEvidenceLike;
}

export interface FileIdentity {
  readonly sizeBytes: number;
  readonly contentHash: string;
}

export interface CallSiteTruthInput {
  /** The relation as delivered. */
  readonly relation: RelationLike;
  /** The caller file's lines as they stand on disk, or null when unreadable. */
  readonly sourceLines: readonly string[] | null;
  /** The caller file's identity in the index, or null when the file is not indexed. */
  readonly indexedFile: FileIdentity | null;
  /** The caller file's identity on disk, or null when unreadable. */
  readonly actualFile: FileIdentity | null;
  /** The caller symbol's indexed span, or null when the symbol is not indexed. */
  readonly callerSpan: { readonly startLine: number; readonly endLine: number } | null;
  /** The callee's indexed local name: what a truthful `referenceName` must equal. */
  readonly expectedCallee: string;
}

/** The product renders the first call-site line, trimmed, capped at this many characters. */
export const RENDERED_LINE_CAP = 240;

// ---------------------------------------------------------------- faults

export type CallSiteTruthFault =
  | "NO_CALL_SITE"
  | "SITE_OUTSIDE_CALLER_SPAN"
  | "SOURCE_STALE"
  | "SOURCE_UNREADABLE"
  | "SPAN_TEXT_LACKS_CALLEE"
  | "REFERENCE_NAME_MISMATCH"
  | "SOURCE_TEXT_NOT_AT_SPAN"
  | "SOURCE_TEXT_LACKS_CALLEE";

/**
 * Every way the delivered relation could be untrue, in the order the audit
 * reports them. A relation with NO faults is source-anchored: the graph says
 * A calls B, and the product shows the file's own line at the persisted site,
 * naming B, in a file the index still describes.
 *
 * Faults about the SITE (the first four) are faults of the underlying truth and
 * are reported even when no text was rendered; faults about the TEXT (the last
 * three) apply only when text was rendered, because absent text is a weaker
 * claim, not a false one.
 */
export function callSiteTruthFaults(input: CallSiteTruthInput): CallSiteTruthFault[] {
  const faults: CallSiteTruthFault[] = [];
  const evidence = input.relation.evidence ?? {};
  const site = evidence.callSites?.[0];
  if (site === undefined) faults.push("NO_CALL_SITE");
  if (site !== undefined && input.callerSpan !== null
    && (site.startLine < input.callerSpan.startLine || site.startLine > input.callerSpan.endLine)) {
    faults.push("SITE_OUTSIDE_CALLER_SPAN");
  }
  if (input.actualFile === null || input.sourceLines === null) faults.push("SOURCE_UNREADABLE");
  else if (input.indexedFile === null
    || input.indexedFile.sizeBytes !== input.actualFile.sizeBytes
    || input.indexedFile.contentHash !== input.actualFile.contentHash) {
    faults.push("SOURCE_STALE");
  }
  // The span the rendered text must come from: the persisted site, or — for a
  // located occurrence with no persisted site — the line the product says it
  // located. A scan is real source too; it must still be the file's own line.
  const textSpan = site !== undefined
    ? { start: site.startLine, end: site.endLine }
    : evidence.locationKind === "caller_span_scan" && input.relation.source?.lineSpan !== undefined
      ? input.relation.source.lineSpan
      : undefined;
  const spanLines = textSpan !== undefined && input.sourceLines !== null
    ? input.sourceLines.slice(textSpan.start - 1, textSpan.end)
    : null;
  if (spanLines !== null && !spanLines.join("\n").includes(input.expectedCallee)) {
    faults.push("SPAN_TEXT_LACKS_CALLEE");
  }

  const text = evidence.sourceText;
  if (typeof text === "string" && text.trim().length > 0) {
    if (evidence.referenceName !== input.expectedCallee) faults.push("REFERENCE_NAME_MISMATCH");
    if (spanLines !== null && !spanLines.some((line) => renderedLineMatches(text, line))) {
      faults.push("SOURCE_TEXT_NOT_AT_SPAN");
    }
    if (!text.includes(input.expectedCallee)) faults.push("SOURCE_TEXT_LACKS_CALLEE");
  }
  return faults;
}

/**
 * The product's rendering rule, inverted: a rendered line is the file's line
 * trimmed of surrounding whitespace and cut at `RENDERED_LINE_CAP` characters.
 * Anything else — a different line, a re-indented line, an edited line — is not
 * the source.
 */
export function renderedLineMatches(rendered: string, sourceLine: string): boolean {
  const expected = sourceLine.trim().slice(0, RENDERED_LINE_CAP);
  return rendered.trim() === expected;
}

// ------------------------------------------------------- renderability

export const RENDERABILITY_CLASSES = [
  "RENDERABLE_FROM_EXISTING_TRUTH",
  "GRAPH_ONLY_TRUTH",
  "AMBIGUOUS_TRUTH",
  "STALE_TRUTH",
  "NO_TRUTH",
] as const;

export type RenderabilityClass = (typeof RENDERABILITY_CLASSES)[number];

/**
 * What the INDEX can support for one expected impact item, judged on the CORE
 * relation (before any product envelope), so the classification is about the
 * truth VTRACE holds and not about what one surface chose to show.
 *
 *   RENDERABLE_FROM_EXISTING_TRUTH  a persisted site inside the caller's span,
 *                                   in a file the index still describes, whose
 *                                   text names the callee, and the core already
 *                                   produced that line — nothing but projection
 *                                   stands between the index and the model.
 *   GRAPH_ONLY_TRUTH                the edge is real but no site was persisted,
 *                                   or the site exists and no line could be
 *                                   built from it; the relationship can be
 *                                   stated, the expression cannot be shown.
 *   AMBIGUOUS_TRUTH                 the site exists but its text does not name
 *                                   the callee, or the rendered text disagrees
 *                                   with the file: showing it would strengthen
 *                                   the structural claim beyond the evidence.
 *   STALE_TRUTH                     the file on disk is not the file the index
 *                                   describes, or the site fell outside the
 *                                   caller's indexed span: any line is a guess.
 *   NO_TRUTH                        the core delivered no relation for the
 *                                   expected caller at all.
 */
export function classifyRenderability(
  coreRelation: RelationLike | null,
  faults: readonly CallSiteTruthFault[],
): RenderabilityClass {
  if (coreRelation === null) return "NO_TRUTH";
  if (faults.includes("SOURCE_STALE") || faults.includes("SOURCE_UNREADABLE") || faults.includes("SITE_OUTSIDE_CALLER_SPAN")) {
    return "STALE_TRUTH";
  }
  if (faults.includes("SPAN_TEXT_LACKS_CALLEE") || faults.includes("SOURCE_TEXT_NOT_AT_SPAN")
    || faults.includes("SOURCE_TEXT_LACKS_CALLEE") || faults.includes("REFERENCE_NAME_MISMATCH")) {
    return "AMBIGUOUS_TRUTH";
  }
  if (faults.includes("NO_CALL_SITE")) return "GRAPH_ONLY_TRUTH";
  const text = coreRelation.evidence?.sourceText;
  if (typeof text !== "string" || text.trim().length === 0) return "GRAPH_ONLY_TRUTH";
  return "RENDERABLE_FROM_EXISTING_TRUTH";
}

// ------------------------------------------------------- frozen rule

/** The committed A15 predicate, applied to a delivered relation. Not restated. */
export function frozenA15Rendered(relation: RelationLike | null | undefined): boolean {
  if (!relation) return false;
  return callSiteIsRendered(relation.evidence ?? {});
}

// ------------------------------------------------------- identities / roles

/**
 * One delivered call-site item has one accounting identity: the persisted edge
 * and the site the product rendered. Two traversal routes to the same edge
 * share it; two sites of the same edge do not.
 */
export function callSiteIdentity(relation: RelationLike): string {
  const site = relation.evidence?.callSites?.[0];
  const edge = relation.edgeId ?? relation.id ?? "?";
  return site === undefined ? `${edge}@none` : `${edge}@${site.startLine}-${site.endLine}`;
}

/**
 * The repository's own vocabulary for what an impact item IS, composed from
 * fields the relation already carries. No second taxonomy: `kind` names the
 * relationship, `strength` names the resolver's certainty, `direction` names
 * the side, and `locationKind` names where the evidence comes from.
 *
 * `potential caller` is never derivable from a direct relation: potential
 * callers are a separate collection the product keeps apart on purpose.
 */
export function impactRole(relation: RelationLike): string {
  const side = relation.direction === "incoming" ? "" : relation.direction === "outgoing" ? "outgoing " : "";
  const noun = relation.kind === "calls" ? "caller"
    : relation.kind === "imports" || relation.kind === "re_exports" ? "importer"
      : relation.kind === "references" ? "referrer"
        : relation.kind === "inherits" || relation.kind === "implements" ? "subtype"
          : relation.kind === "contains" || relation.kind === "defines" ? "container"
            : relation.kind ?? "relation";
  const certainty = relation.strength ?? "unknown";
  const where = relation.evidence?.locationKind === "edge_site" ? "persisted call site"
    : relation.evidence?.locationKind === "caller_span_scan" ? "located occurrence"
      : relation.evidence?.locationKind === "source_symbol_span" ? "symbol span only"
        : relation.evidence?.locationKind ?? "unknown location";
  return `${side}${certainty} ${noun} (${where})`;
}

/** Same-file or cross-file, from the delivered endpoints; null when either path is missing. */
export function crossFile(relation: RelationLike): boolean | null {
  const from = relation.source?.path;
  const to = relation.target?.path;
  if (from === undefined || to === undefined) return null;
  return from !== to;
}

// -------------------------------------------------------- counterfactual

/**
 * The serialized cost, under the impact envelope's own chars/4 rule, that the
 * evidence keys the product currently strips would add to one relation.
 * `referenceName` and `sourceText` are the two the frozen rule reads. Each key
 * is counted with the separator it needs inside an existing object.
 */
export function strippedEvidenceCharacters(coreEvidence: RelationEvidenceLike): number {
  let characters = 0;
  if (typeof coreEvidence.sourceText === "string") characters += JSON.stringify({ sourceText: coreEvidence.sourceText }).length - 1;
  if (typeof coreEvidence.referenceName === "string") characters += JSON.stringify({ referenceName: coreEvidence.referenceName }).length - 1;
  return characters;
}

export const impactTokens = (characters: number): number => Math.ceil(characters / 4);

// ------------------------------------------------------------- summaries

export function countBy<T extends string>(values: readonly T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
