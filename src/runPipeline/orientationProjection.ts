/**
 * The agent-facing orientation projection.
 *
 *     FULL AUTHORITATIVE PIPELINE RESULT
 *              |
 *      ORIENTATION PROJECTOR          <- this module
 *              |
 *      bounded orientation packet     -> structuredContent AND content[0].text
 *
 * `run_pipeline` computes everything it always computed. What changed is what
 * the model is handed by default: the authoritative result stays server-side and
 * the agent receives the smallest truthful projection of it that supports a first
 * repository decision.
 *
 * WHY. M169 priced the full-disclosure response at $0.0985 a task to displace
 * $0.0026 of investigation — thirty-eight times its worth. M170 showed the cost
 * could not be recovered by mediating the agent's own reads. M171 showed the
 * price was a property of the DISCLOSURE and not of the product category: the
 * response is 21,318 characters and carries 895 characters of code, asserting 89
 * distinct facts across 146 surfaces. Projecting instead of serialising costs a
 * median of 603-621 model-visible tokens against 6,766-6,884, an eleven-fold
 * reduction, with gold file and gold symbol delivery unchanged to the percentage
 * point on two independent hundred-task corpora.
 *
 * Four rules make the design what it is.
 *
 *   SOUND, NOT COMPLETE       the packet may omit a supported fact; it may never
 *                             assert one the authoritative state does not
 *                             support. Every string below is either verbatim
 *                             authoritative or one of the frozen phrases.
 *
 *   NO FALSE ABSENCE          omission is not a negative claim, which is only
 *                             true because one global boundary line says so on
 *                             every resolved packet, unconditionally. A boundary
 *                             that appeared only sometimes would make its absence
 *                             informative — and its absence would fall exactly
 *                             where the packet is most selective.
 *
 *   ENOUGH, THEN STOP         the projector has no notion of remaining space, so
 *                             there is nothing for freed space to attract. M166
 *                             watched the packer refill an emptied envelope; this
 *                             cannot, because what ends a packet is the
 *                             authoritative supply running out and not a budget
 *                             being reached. Holdout supply is a median of 5 and
 *                             a maximum of 9; the ceiling does not engage until
 *                             46.
 *
 *   VERBATIM OR FROZEN        a claim is never re-worded. Re-wording is how
 *                             "potential caller" becomes "caller" and how "not
 *                             observed" becomes "absent".
 *
 * ONE BOUND, AND IT IS REAL. M171's projector declared a token ceiling, set it on
 * every rung, and read it nowhere; the bound that actually acted was an
 * undeclared count cap of five. On the clean holdout that cap withheld 66
 * authoritative related entries and bought nothing — delivering all 66 leaves
 * gold file and gold symbol delivery identical and the median packet at 621
 * tokens. So the cap is gone and the ceiling is enforced, checked against the
 * assembled packet rather than an estimate of one.
 *
 * WHAT THE CEILING MAY NOT EVICT: the focus and the interpretation-critical
 * notes. A claim that cannot be rendered truthfully is omitted rather than
 * weakened, and a packet whose qualifier was dropped for budget is precisely the
 * overstrong rendering that rule forbids. The ceiling governs the related list.
 *
 * NOT A SECOND PIPELINE. There is one authoritative `run_pipeline`. This module
 * selects from its result; it computes nothing about the repository, ranks
 * nothing, scores nothing, and can surface no source the authoritative response
 * did not already carry. `detail=debug` returns the authoritative result whole.
 *
 * PURE. No I/O, no clock, no randomness, no database.
 */

/**
 * The single global claim boundary. It appears on EVERY resolved packet, never
 * conditionally, because it is what licenses every omission the projector makes.
 */
export const ORIENTATION_BOUNDARY =
  "Focused orientation: task-relevant evidence selected from the indexed worktree, not an exhaustive repository listing. Items not shown are not thereby absent.";

export const ORIENTATION_TRUNCATION_NOTE = "The excerpt above is the head of a longer span.";

/**
 * The pivot-neighborhood relationship enum, rendered.
 *
 * The raw values are internal tokens. `fallback_symbol_window` means "another
 * symbol in the same file, reached by no edge at all", and shipping that token to
 * a model is both unreadable and an invitation to infer a relationship that does
 * not exist. Each phrase states a fact about the INDEX, never about the world,
 * and preserves the exact strength of the underlying claim: an indexed call edge
 * stays an indexed call edge, and the no-relationship case says so in words.
 *
 * Exhaustive over the reason enum and FAILS CLOSED: a reason absent from this
 * table carries no claim, so the neighbour is dropped rather than shipped under
 * an opaque or over-strong label. A new internal token can never leak by default.
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

/** Every phrase the projector may author. Nothing else is written into a packet. */
export const ORIENTATION_FROZEN_PHRASES: readonly string[] = Object.freeze([
  ORIENTATION_BOUNDARY,
  ORIENTATION_TRUNCATION_NOTE,
  ...Object.values(NEIGHBOR_RELATION_PHRASES),
]);

export const ORIENTATION_SCHEMA_VERSION = "run_pipeline.orientation/1" as const;

/**
 * The frozen policy. Qualified offline on two disjoint hundred-task corpora
 * before it was wired here; `benchmarks/.../results/stage5_m172_frozen_policy.json`
 * records why each value is what it is.
 */
export const ORIENTATION_POLICY = Object.freeze({
  /** Model-visible token bound on the whole packet. Enforced. Governs `related`. */
  ceilingTokens: 2000,
  /** Head bound on the focus excerpt, in characters, cut on a line boundary. */
  focusCodeCharacters: 1800,
});

/**
 * M166's measured calibration for serialized tool-result JSON, 0.3174 tokens per
 * character over 363 provider-reported samples. `characters / 4` understates this
 * payload materially, which is why the ceiling is applied through it.
 */
const TOKENS_PER_CHARACTER = 0.3174032272551657;

export const orientationTokens = (packet: OrientationPacket): number =>
  Math.max(0, Math.round(JSON.stringify(packet).length * TOKENS_PER_CHARACTER));

export interface OrientationFocus {
  /** `path::Symbol` exactly as the authoritative state spells it. */
  readonly at: string;
  readonly file: string;
  readonly lines: string | null;
  /**
   * What `code` IS — full body, signature-only skeleton, and so on.
   * Interpretation-critical: a skeleton shown without this label reads as the
   * implementation.
   */
  readonly form: string | null;
  /** The authoritative selection reason, verbatim and unabridged. */
  readonly why: string | null;
  readonly code: string | null;
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
  readonly schemaVersion: typeof ORIENTATION_SCHEMA_VERSION;
  readonly focus: OrientationFocus;
  readonly related: readonly OrientationRelated[];
  readonly boundary: string;
  /** Interpretation-critical only. Absent when there is nothing to say. */
  readonly notes?: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asArray = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

/**
 * Split the authoritative rendering into per-item bodies.
 *
 * This is the ONLY place a serialized response carries source text — pivot
 * neighborhood excerpt bodies are stripped before the response leaves the server.
 * Sourcing the projection's code from here is what keeps this a projection: the
 * packet can never show source the authoritative response does not already show.
 */
function parseRenderedBodies(rendered: string): ReadonlyMap<string, string> {
  const bodies = new Map<string, string>();
  if (rendered === "") return bodies;
  for (const section of rendered.split(/\n## /).slice(1)) {
    const idMatch = /^\[([^\]]+)\]/.exec(section);
    if (idMatch === null) continue;
    const lines = section.split("\n");
    let cursor = 1;
    while (cursor < lines.length && /^(roles|mode|lines|why|kind|relation):/.test(lines[cursor]!)) cursor += 1;
    while (cursor < lines.length && lines[cursor]!.trim() === "") cursor += 1;
    bodies.set(idMatch[1]!, lines.slice(cursor).join("\n").trim());
  }
  return bodies;
}

/** Head-bound a body on a line boundary, so a truncated excerpt is never a half line. */
function headBound(body: string, limit: number): { readonly cut: string; readonly truncated: boolean } {
  if (body.length <= limit) return { cut: body, truncated: false };
  const slice = body.slice(0, limit);
  const lastNewline = slice.lastIndexOf("\n");
  const chosen = lastNewline > limit * 0.4 ? slice.slice(0, lastNewline) : slice;
  return { cut: chosen.trimEnd(), truncated: true };
}

function assemble(
  focus: OrientationFocus,
  related: readonly OrientationRelated[],
  notes: readonly string[],
): OrientationPacket {
  return Object.freeze({
    schemaVersion: ORIENTATION_SCHEMA_VERSION,
    focus,
    related: Object.freeze([...related]),
    boundary: ORIENTATION_BOUNDARY,
    ...(notes.length === 0 ? {} : { notes: Object.freeze([...notes]) }),
  });
}

/**
 * Project an authoritative `run_pipeline` result into an orientation packet, or
 * return null when the result is not one the projection is defined over.
 *
 * Returning null is deliberate and is how failure semantics are preserved: a
 * stale index, an unready repository, a delivery failure or an empty retrieval
 * keeps its full, unambiguous authoritative envelope — `reason`, `nextTool`,
 * readiness and all. A compact success output does not license a vague failure
 * output, so the projector declines rather than compressing.
 */
export function projectRunPipelineOrientation(output: unknown): OrientationPacket | null {
  if (!isRecord(output)) return null;

  const productContext = isRecord(output.productContext) ? output.productContext : null;
  if (productContext === null) return null;
  if (productContext.resolved !== true) return null;
  if (productContext.retrievalFound === false) return null;
  if (productContext.deliveryFailed === true) return null;

  const readiness = (() => {
    const diagnostics = isRecord(output.diagnostics) ? output.diagnostics : {};
    const freshness = isRecord(diagnostics.freshness) ? diagnostics.freshness : {};
    return isRecord(freshness.readiness) ? freshness.readiness : null;
  })();
  if (readiness !== null && readiness.ready !== true) return null;

  const bodies = parseRenderedBodies(text(productContext.modelVisibleContext));
  const items = asArray(productContext.items)
    .filter((item) => text(item.fqName) !== "")
    .map((item) => {
      const span = isRecord(item.lineSpan) ? item.lineSpan : null;
      return {
        fqName: text(item.fqName),
        path: text(item.path),
        lines: span === null ? null : `${text(span.start)}-${text(span.end)}`,
        contentMode: text(item.contentMode),
        roles: Array.isArray(item.roles) ? item.roles.map(text) : [],
        reasons: Array.isArray(item.selectionReasons) ? item.selectionReasons.map(text) : [],
        body: bodies.get(text(item.id)) ?? "",
      };
    });
  if (items.length === 0) return null;

  const leadPivot = text(productContext.leadPivot);
  const focusItem = items.find((item) => item.fqName === leadPivot)
    ?? items.find((item) => item.roles.includes("pivot"))
    ?? items[0]!;

  const bounded = headBound(focusItem.body, ORIENTATION_POLICY.focusCodeCharacters);
  const focus: OrientationFocus = Object.freeze({
    at: focusItem.fqName,
    file: focusItem.path,
    lines: focusItem.lines,
    form: focusItem.contentMode === "" ? null : focusItem.contentMode,
    why: focusItem.reasons[0] ?? null,
    code: bounded.cut === "" ? null : bounded.cut,
    codeTruncated: bounded.truncated,
  });

  // Interpretation-critical notes only. Everything else stays in the
  // authoritative result and is reachable at detail=debug.
  const notes: string[] = [];
  const freshness = isRecord(productContext.freshness) ? productContext.freshness : {};
  const freshnessStatus = text(freshness.status);
  if (freshnessStatus !== "" && freshnessStatus !== "fresh") {
    // Verbatim authoritative status: a re-worded freshness claim is exactly the
    // kind of strengthening the verbatim rule exists to prevent.
    notes.push(`Index freshness: ${freshnessStatus} (${text(freshness.reason)}).`);
  }
  const routing = isRecord(output.workspaceRouting) ? output.workspaceRouting : {};
  if (routing.isWorkspace === true && text(routing.outcome) !== "single_repository") {
    notes.push(`Workspace routing: ${text(routing.outcome)}. ${text(routing.reason)}`);
  }
  if (focus.codeTruncated) notes.push(ORIENTATION_TRUNCATION_NOTE);

  // The admissible list, in AUTHORITATIVE order. Items first, then pivot
  // neighbours; admission takes a prefix, which is what keeps a tighter bound's
  // output a subset of a looser one's. No re-ranking, ever.
  const seen = new Set<string>([focusItem.fqName]);
  const candidates: OrientationRelated[] = [];
  const consider = (fqName: string, path: string, lines: string | null, how: string): void => {
    if (fqName === "" || how === "" || seen.has(fqName)) return;
    seen.add(fqName);
    candidates.push(Object.freeze({ at: fqName, file: path, lines, how }));
  };
  for (const item of items) {
    // The item's own first selection reason IS the relationship claim the
    // authoritative state makes about it. Reused verbatim; never generalized.
    consider(item.fqName, item.path, item.lines, item.reasons[0] ?? item.roles.join(", "));
  }
  for (const neighborhood of asArray(output.pivotNeighborhood)) {
    for (const excerpt of asArray(neighborhood.excerpts)) {
      consider(
        text(excerpt.fqName),
        text(excerpt.filePath),
        `${text(excerpt.startLine)}-${text(excerpt.endLine)}`,
        NEIGHBOR_RELATION_PHRASES[text(excerpt.reason)] ?? "",
      );
    }
  }

  const related: OrientationRelated[] = [];
  for (const candidate of candidates) {
    const next = [...related, candidate];
    if (orientationTokens(assemble(focus, next, notes)) > ORIENTATION_POLICY.ceilingTokens) break;
    related.push(candidate);
  }

  return assemble(focus, related, notes);
}
