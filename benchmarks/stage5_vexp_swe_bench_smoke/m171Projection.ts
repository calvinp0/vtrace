/**
 * M171-B/C — the agent orientation projector.
 *
 *     FULL AUTHORITATIVE PIPELINE STATE
 *              |
 *      AGENT ORIENTATION PROJECTOR      <- this module
 *              |
 *      bounded orientation packet
 *
 * The projector takes the authoritative `run_pipeline` output EXACTLY as the
 * pipeline produced it and decides what the model is entitled to see by default.
 * It computes nothing about the repository: no ranking, no scoring, no new
 * relationship, no source it was not already given. Every string it emits is
 * either a verbatim authoritative string or one of the frozen contract phrases
 * declared below (§37, §38).
 *
 * Four rules make the design what it is.
 *
 *   SOUND, NOT COMPLETE (§6)      the packet may omit a supported fact; it may
 *                                 never assert one the state does not support.
 *
 *   NO FALSE ABSENCE (§7)         omission is not a negative claim, which is
 *                                 only true because one global boundary line
 *                                 says so on every packet, unconditionally.
 *
 *   ENOUGH, THEN STOP (§17, §46)  the rung is a CEILING. A packet complete at
 *                                 1,300 tokens under a 2,000 ceiling stays at
 *                                 1,300. Nothing is added because room exists.
 *                                 M166 watched the packer refill a freed
 *                                 envelope; this projector cannot, because it
 *                                 has no notion of remaining space to fill.
 *
 *   VERBATIM OR FROZEN (§49)      a claim is never re-worded. Re-wording is how
 *                                 "potential caller" becomes "caller" and how
 *                                 "not observed" becomes "absent".
 *
 * Written after M169 priced the mandatory full-disclosure pipeline at $0.0985 per
 * task against $0.0026 of investigation displaced. The pipeline was not the
 * problem; sending the agent everything the pipeline knew was.
 *
 * OFFLINE. This module is a benchmark candidate, not product code: M171-E's
 * gold-symbol gate did not pass, so §19's rule applies and no projector is wired
 * into `run_pipeline`. Nothing in `src/` imports it.
 *
 * PURE. No I/O, no product imports, no clock, no randomness.
 */

// ---- the contract's own frozen prose ------------------------------

/**
 * The single global claim boundary (§8). It appears on EVERY resolved packet,
 * never conditionally, because it is what licenses every omission the projector
 * makes. A boundary that appeared only sometimes would make its absence
 * informative, and its absence is exactly when the packet is most selective.
 */
export const ORIENTATION_BOUNDARY =
  "Focused orientation: task-relevant evidence selected from the indexed worktree, not an exhaustive repository listing. Items not shown are not thereby absent.";

/**
 * The pivot-neighborhood relationship enum, rendered.
 *
 * The raw values are internal tokens — `fallback_symbol_window` means "another
 * symbol in the same file, reached by no edge at all", and shipping that token
 * to a model as a relationship label is both unreadable and an invitation to
 * infer a relationship that does not exist. Each phrase below states a fact
 * about the INDEX, never about the world, and preserves the exact strength of
 * the underlying claim: an indexed call edge stays an indexed call edge, and the
 * no-relationship case says so in words.
 *
 * The table is exhaustive over `PivotNeighborhoodReason` and fails CLOSED: a
 * reason absent from it carries no claim and the neighbour is dropped, so a new
 * internal token can never leak or be strengthened by default.
 */
export const NEIGHBOR_RELATION_PHRASES: Readonly<Record<string, string>> = Object.freeze({
  caller: "calls the focus symbol (indexed call edge)",
  callee: "called by the focus symbol (indexed call edge)",
  importer: "imports the focus symbol's module (indexed import edge)",
  imported: "imported by the focus symbol's module (indexed import edge)",
  reference: "references the focus symbol (indexed reference edge)",
  sibling: "declared in the same scope as the focus symbol",
  support: "selected as supporting evidence for this task",
  fallback_symbol_window: "in the same file as the focus symbol; no indexed relationship to it",
});

/** Frozen phrases. Nothing else may be authored into a packet. */
export const FROZEN_PHRASES: readonly string[] = Object.freeze([
  ORIENTATION_BOUNDARY,
  "The excerpt above is the head of a longer span.",
  ...Object.values(NEIGHBOR_RELATION_PHRASES),
]);

export const OrientationState = Object.freeze({
  Resolved: "resolved",
  NoEvidence: "no_evidence",
  NotReady: "not_ready",
  Failed: "failed",
});
export type OrientationState = (typeof OrientationState)[keyof typeof OrientationState];

// ---- dose rungs ---------------------------------------------------

export interface Rung {
  readonly name: string;
  /** Model-visible token ceiling for the whole packet. NOT a target (§46). */
  readonly ceilingTokens: number;
  /** Head-bound on the focus excerpt, in characters. */
  readonly focusCodeCharacters: number;
  /** How many related locations may be named. Identity and relation only. */
  readonly relatedCap: number;
}

export const RUNGS: readonly Rung[] = Object.freeze([
  Object.freeze({ name: "R1000", ceilingTokens: 1000, focusCodeCharacters: 700, relatedCap: 2 }),
  Object.freeze({ name: "R1500", ceilingTokens: 1500, focusCodeCharacters: 1200, relatedCap: 3 }),
  Object.freeze({ name: "R2000", ceilingTokens: 2000, focusCodeCharacters: 1800, relatedCap: 5 }),
  Object.freeze({ name: "R2500", ceilingTokens: 2500, focusCodeCharacters: 2400, relatedCap: 7 }),
]);

export const rungByName = (name: string): Rung => {
  const found = RUNGS.find((rung) => rung.name === name);
  if (found === undefined) throw new Error(`unknown rung ${name}`);
  return found;
};

// ---- the packet ---------------------------------------------------

export interface OrientationFocus {
  /** `path::Symbol` exactly as the authoritative state spells it. */
  readonly at: string;
  readonly file: string;
  readonly lines: string | null;
  /**
   * What the `code` field IS. Interpretation-critical (§48): a skeleton shown
   * without this label reads as the implementation.
   */
  readonly form: string | null;
  /** The authoritative selection reason, verbatim and unabridged. */
  readonly why: string | null;
  readonly code: string | null;
  /** True when `code` is a head-bounded prefix of the authoritative excerpt. */
  readonly codeTruncated: boolean;
}

export interface OrientationRelated {
  readonly at: string;
  readonly file: string;
  readonly lines: string | null;
  /** The authoritative relationship or role string, verbatim. Never strengthened. */
  readonly how: string;
}

export interface OrientationPacket {
  readonly schemaVersion: string;
  readonly state: OrientationState;
  readonly focus: OrientationFocus | null;
  readonly related: readonly OrientationRelated[];
  readonly boundary: string;
  /** Interpretation-critical only. Absent when there is nothing to say. */
  readonly notes?: readonly string[];
  /** Present only on a non-resolved state; never compressed (§11, §79). */
  readonly problem?: {
    readonly reason: string;
    readonly recommendedAction: string | null;
    readonly readiness: Readonly<Record<string, unknown>> | null;
  };
}

export const ORIENTATION_SCHEMA_VERSION = "run_pipeline.orientation/1";

// ---- reading the authoritative state ------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asArray = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

/**
 * Split the authoritative rendering into per-item bodies.
 *
 * The rendering is the ONLY place a serialized `run_pipeline` response carries
 * source text — `pivotNeighborhood[].excerpts[].text` is stripped before the
 * response leaves the server. Sourcing the projection's code from here is what
 * keeps M171 a projection: the packet can never show source the current default
 * does not already disclose, so a size comparison is not confounded by a content
 * change (§38).
 */
export function parseRenderedBodies(rendered: string): ReadonlyMap<string, string> {
  const bodies = new Map<string, string>();
  if (rendered === "") return bodies;
  const sections = rendered.split(/\n## /);
  for (const section of sections.slice(1)) {
    const idMatch = /^\[([^\]]+)\]/.exec(section);
    if (idMatch === null) continue;
    const lines = section.split("\n");
    let cursor = 1;
    while (cursor < lines.length && /^(roles|mode|lines|why|kind|relation):/.test(lines[cursor]!)) cursor += 1;
    while (cursor < lines.length && lines[cursor]!.trim() === "") cursor += 1;
    const body = lines.slice(cursor).join("\n").trim();
    bodies.set(idMatch[1]!, body);
  }
  return bodies;
}

/**
 * Everything the projector is allowed to look at, pulled out of the
 * authoritative response once so the selection logic reads as selection.
 */
interface AuthoritativeView {
  readonly state: OrientationState;
  readonly problemReason: string;
  readonly recommendedAction: string | null;
  readonly readiness: Record<string, unknown> | null;
  readonly leadPivot: string;
  readonly items: readonly {
    readonly id: string;
    readonly fqName: string;
    readonly path: string;
    readonly lines: string | null;
    readonly contentMode: string;
    readonly roles: readonly string[];
    readonly reasons: readonly string[];
    readonly body: string;
  }[];
  readonly neighbors: readonly { readonly fqName: string; readonly path: string; readonly lines: string | null; readonly reason: string }[];
  readonly notes: readonly string[];
}

function readAuthoritative(output: Record<string, unknown>): AuthoritativeView {
  const productContext = isRecord(output.productContext) ? output.productContext : {};
  const diagnostics = isRecord(output.diagnostics) ? output.diagnostics : {};
  const diagFreshness = isRecord(diagnostics.freshness) ? diagnostics.freshness : {};
  const readiness = isRecord(diagFreshness.readiness) ? (diagFreshness.readiness as Record<string, unknown>) : null;
  const bodies = parseRenderedBodies(text(productContext.modelVisibleContext));

  const items = asArray(productContext.items)
    .filter((item) => text(item.fqName) !== "")
    .map((item) => {
      const span = isRecord(item.lineSpan) ? item.lineSpan : null;
      return {
        id: text(item.id),
        fqName: text(item.fqName),
        path: text(item.path),
        lines: span === null ? null : `${text(span.start)}-${text(span.end)}`,
        contentMode: text(item.contentMode),
        roles: Object.freeze(Array.isArray(item.roles) ? item.roles.map(text) : []),
        reasons: Object.freeze(Array.isArray(item.selectionReasons) ? item.selectionReasons.map(text) : []),
        body: bodies.get(text(item.id)) ?? "",
      };
    });

  const neighbors: { fqName: string; path: string; lines: string | null; reason: string }[] = [];
  for (const neighborhood of asArray(output.pivotNeighborhood)) {
    for (const excerpt of asArray(neighborhood.excerpts)) {
      const fqName = text(excerpt.fqName);
      if (fqName === "") continue;
      neighbors.push({
        fqName,
        path: text(excerpt.filePath),
        lines: `${text(excerpt.startLine)}-${text(excerpt.endLine)}`,
        reason: text(excerpt.reason),
      });
    }
  }

  // Interpretation-critical notes only. Everything else is DEBUG_ONLY.
  const notes: string[] = [];
  const freshness = isRecord(productContext.freshness) ? productContext.freshness : {};
  const freshnessStatus = text(freshness.status);
  if (freshnessStatus !== "" && freshnessStatus !== "fresh") {
    // Verbatim authoritative status, because a re-worded freshness claim is
    // exactly the kind of strengthening §49 forbids.
    notes.push(`Index freshness: ${freshnessStatus} (${text(freshness.reason)}).`);
  }
  const routing = isRecord(output.workspaceRouting) ? output.workspaceRouting : {};
  if (routing.isWorkspace === true && text(routing.outcome) !== "single_repository") {
    notes.push(`Workspace routing: ${text(routing.outcome)}. ${text(routing.reason)}`);
  }

  const resolved = productContext.resolved === true;
  const retrievalFound = productContext.retrievalFound === true;
  const ready = readiness === null ? true : readiness.ready === true;
  const state: OrientationState = !ready
    ? OrientationState.NotReady
    : productContext.deliveryFailed === true
      ? OrientationState.Failed
      : (!resolved || !retrievalFound || items.length === 0)
        ? OrientationState.NoEvidence
        : OrientationState.Resolved;

  return {
    state,
    problemReason: text(productContext.resultState) || text(readiness?.reason) || "unknown",
    recommendedAction: readiness === null ? null : (text(readiness.recommendedAction) || null),
    readiness,
    leadPivot: text(productContext.leadPivot),
    items,
    neighbors,
    notes,
  };
}

// ---- selection ----------------------------------------------------

/** Head-bound a body on a line boundary, so a truncated excerpt is never a half line. */
function headBound(body: string, limit: number): { readonly text: string; readonly truncated: boolean } {
  if (body.length <= limit) return { text: body, truncated: false };
  const slice = body.slice(0, limit);
  const lastNewline = slice.lastIndexOf("\n");
  const cut = lastNewline > limit * 0.4 ? slice.slice(0, lastNewline) : slice;
  return { text: cut.trimEnd(), truncated: true };
}

/**
 * Project one authoritative response at one rung.
 *
 * Selection order is the AUTHORITATIVE order — `productContext.items` as the
 * pipeline delivered them, then pivot-neighborhood excerpts. The projector never
 * re-ranks (§37). `relatedCap` takes a PREFIX of that order, which is what makes
 * the rungs nested (§45): anything named at R1000 is named at R2500.
 */
export function projectOrientation(output: Record<string, unknown>, rung: Rung): OrientationPacket {
  const view = readAuthoritative(output);

  if (view.state !== OrientationState.Resolved) {
    // §11/§79: a compact success output does not license a vague failure output.
    return Object.freeze({
      schemaVersion: ORIENTATION_SCHEMA_VERSION,
      state: view.state,
      focus: null,
      related: Object.freeze([]),
      boundary: ORIENTATION_BOUNDARY,
      ...(view.notes.length === 0 ? {} : { notes: Object.freeze([...view.notes]) }),
      problem: Object.freeze({
        reason: view.problemReason,
        recommendedAction: view.recommendedAction,
        readiness: view.readiness === null ? null : Object.freeze({ ...view.readiness }),
      }),
    });
  }

  const focusItem = view.items.find((item) => item.fqName === view.leadPivot)
    ?? view.items.find((item) => item.roles.includes("pivot"))
    ?? view.items[0]!;

  const bounded = headBound(focusItem.body, rung.focusCodeCharacters);
  const focus: OrientationFocus = Object.freeze({
    at: focusItem.fqName,
    file: focusItem.path,
    lines: focusItem.lines,
    form: focusItem.contentMode === "" ? null : focusItem.contentMode,
    why: focusItem.reasons[0] ?? null,
    code: bounded.text === "" ? null : bounded.text,
    codeTruncated: bounded.truncated,
  });

  const seen = new Set<string>([focusItem.fqName]);
  const related: OrientationRelated[] = [];
  const consider = (fqName: string, path: string, lines: string | null, how: string): void => {
    if (related.length >= rung.relatedCap || seen.has(fqName) || how === "") return;
    seen.add(fqName);
    related.push(Object.freeze({ at: fqName, file: path, lines, how }));
  };
  for (const item of view.items) {
    // The item's own first selection reason IS the relationship claim the
    // authoritative state makes about it. Reused verbatim; never generalized.
    consider(item.fqName, item.path, item.lines, item.reasons[0] ?? item.roles.join(", "));
  }
  for (const neighbor of view.neighbors) {
    // Fails closed: an unmapped internal token carries no claim, so the neighbour
    // is dropped rather than shipped as an opaque or over-strong label.
    consider(neighbor.fqName, neighbor.path, neighbor.lines, NEIGHBOR_RELATION_PHRASES[neighbor.reason] ?? "");
  }

  const notes = [...view.notes];
  if (focus.codeTruncated) {
    notes.push("The excerpt above is the head of a longer span.");
  }

  return Object.freeze({
    schemaVersion: ORIENTATION_SCHEMA_VERSION,
    state: OrientationState.Resolved,
    focus,
    related: Object.freeze(related),
    boundary: ORIENTATION_BOUNDARY,
    ...(notes.length === 0 ? {} : { notes: Object.freeze(notes) }),
  });
}

// ---- rendering ----------------------------------------------------

/**
 * The protocol-compatible text mirror of the SAME packet (§23, §76).
 *
 * M167 established that both transport representations are needed for
 * compatibility and that the duplicate costs ~0 model tokens in the proven
 * client. It must therefore carry the same compact orientation — never a short
 * summary of a full structured object hidden beside it (§22).
 */
export function renderOrientationText(packet: OrientationPacket): string {
  const lines: string[] = [];
  if (packet.state !== OrientationState.Resolved) {
    lines.push(`VTRACE orientation unavailable: ${packet.state}`);
    lines.push(`reason: ${packet.problem?.reason ?? "unknown"}`);
    if (packet.problem?.recommendedAction != null) lines.push(`action: ${packet.problem.recommendedAction}`);
    for (const note of packet.notes ?? []) lines.push(note);
    lines.push(packet.boundary);
    return lines.join("\n");
  }
  const focus = packet.focus!;
  lines.push("Focus");
  lines.push(`${focus.at}${focus.lines === null ? "" : `  lines ${focus.lines}`}${focus.form === null ? "" : `  [${focus.form}]`}`);
  if (focus.why !== null) lines.push(`why: ${focus.why}`);
  if (focus.code !== null) {
    lines.push("");
    lines.push(focus.code);
  }
  if (packet.related.length > 0) {
    lines.push("");
    lines.push("Related");
    for (const item of packet.related) {
      lines.push(`${item.at}${item.lines === null ? "" : `  lines ${item.lines}`} — ${item.how}`);
    }
  }
  for (const note of packet.notes ?? []) {
    lines.push("");
    lines.push(note);
  }
  lines.push("");
  lines.push(packet.boundary);
  return lines.join("\n");
}

// ---- what the packet claims ---------------------------------------

/**
 * Every location the packet names, and every claim it makes about one.
 *
 * D compares this against the authoritative state. Deriving it from the PACKET
 * rather than from the projector's intentions is the point: it is a reader's
 * view, which is the only view a truthfulness audit may use.
 */
export interface PacketClaims {
  readonly locations: ReadonlySet<string>;
  readonly files: ReadonlySet<string>;
  readonly relationClaims: readonly { readonly at: string; readonly how: string }[];
  readonly codeSpans: readonly { readonly at: string; readonly lines: string | null; readonly form: string | null }[];
  readonly authoredStrings: readonly string[];
}

export function readPacketClaims(packet: OrientationPacket): PacketClaims {
  const locations = new Set<string>();
  const files = new Set<string>();
  const relationClaims: { at: string; how: string }[] = [];
  const codeSpans: { at: string; lines: string | null; form: string | null }[] = [];
  const authored: string[] = [packet.boundary, ...(packet.notes ?? [])];

  if (packet.focus !== null) {
    locations.add(packet.focus.at);
    if (packet.focus.file !== "") files.add(packet.focus.file);
    if (packet.focus.why !== null) relationClaims.push({ at: packet.focus.at, how: packet.focus.why });
    codeSpans.push({ at: packet.focus.at, lines: packet.focus.lines, form: packet.focus.form });
  }
  for (const item of packet.related) {
    locations.add(item.at);
    if (item.file !== "") files.add(item.file);
    relationClaims.push({ at: item.at, how: item.how });
  }
  return Object.freeze({
    locations,
    files,
    relationClaims: Object.freeze(relationClaims),
    codeSpans: Object.freeze(codeSpans),
    authoredStrings: Object.freeze(authored),
  });
}
