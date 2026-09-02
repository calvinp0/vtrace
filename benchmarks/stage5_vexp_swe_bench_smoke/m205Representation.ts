/**
 * M205 — the representation-integrity analyzer, and the frozen A12 rule.
 *
 * PURE over its inputs. Reads one delivered orientation packet, the ledger the
 * projector published for it (M203's accounting authority, consumed and not
 * duplicated), the authoritative supply items the same request rendered, and a
 * SOURCE AUTHORITY the driver binds to the indexed corpus, and decides whether
 * every representation the packet delivers is what it says it is:
 *
 *   a class is the form of the code an item carries, or relationship-only;
 *   a form is code-bearing only if the product's table says so;
 *   source-backed text is a verbatim slice of the indexed file within the
 *   item's span; a signature is the parser's; a skeleton is the index's;
 *   every code is within its declared bound; truncation is stated truthfully;
 *   every routing reason is consistent with what was delivered and what could
 *   have been; the M203 ledger reconciles; no identity is delivered twice.
 *
 * The frozen A12 rule is reproduced VERBATIM from `run_stage5_m197a_engine.ts`
 * and `run_stage5_m197a_report.ts`: a class is `FOCUS:<form>` when the focus
 * carries code, `RELATED_WITH_CODE` for a related entry whose `code` is a
 * string, `RELATIONSHIP_ONLY` otherwise; the count is the number of distinct
 * classes over every C-MED response; MATCHES at >= 3, EXCEEDS at >= 5. Nothing
 * here is a second counting rule.
 */

import { analyzeAccounting, frozenRepresentationClass } from "./m203Accounting";

// ------------------------------------------------------------ the frozen rule

export const A12_MATCH_CLASSES = 3;
export const A12_EXCEED_CLASSES = 5;

/** The engine's per-response class set, verbatim (`representationClasses`). */
export function frozenA12Classes(out: any): string[] {
  const classes = new Set<string>();
  if (out?.focus?.code) classes.add(`FOCUS:${out.focus.form ?? "unknown"}`);
  for (const r of out?.related ?? []) classes.add(typeof r.code === "string" ? "RELATED_WITH_CODE" : "RELATIONSHIP_ONLY");
  return [...classes];
}

export type FrozenVerdict = "VTRACE_EXCEEDS_VEXP_CLAIM" | "VTRACE_MATCHES_VEXP_CLAIM" | "VTRACE_BELOW_VEXP_CLAIM";

/** `band([a12Classes], 3, 5, "atLeast")` from the frozen report. */
export function frozenA12Verdict(distinctClasses: number): FrozenVerdict {
  if (distinctClasses >= A12_EXCEED_CLASSES) return "VTRACE_EXCEEDS_VEXP_CLAIM";
  if (distinctClasses >= A12_MATCH_CLASSES) return "VTRACE_MATCHES_VEXP_CLAIM";
  return "VTRACE_BELOW_VEXP_CLAIM";
}

// ------------------------------------------------------- the product's rules

/** Copied, not imported: the analyzer must not inherit a change to the product's table. */
export const CODE_BEARING_FORMS_EXPECTED = Object.freeze([
  "focused_source", "full_source", "excerpt", "skeleton", "signature", "document_excerpt",
]);
export const RELATIONSHIP_ONLY = "relationship_only";
export const REPRESENTATION_REASONS_EXPECTED = Object.freeze([
  "focus_slot", "upstream_form_delivered", "ceiling", "no_rendered_body", "form_not_code_bearing",
  "neighbour_text_not_carried",
]);
const EXCERPT_MARKER = "# … excerpt compacted for budget …";
const TOKENS_PER_CHARACTER = 0.3174032272551657;
export const tokensOf = (characters: number) => Math.max(0, Math.round(characters * TOKENS_PER_CHARACTER));

/** The product's head-bound rule, restated so the analyzer can recompute an offered form. */
export function headBoundRule(body: string, limit: number): { cut: string; truncated: boolean } {
  if (body.length <= limit) return { cut: body, truncated: false };
  const slice = body.slice(0, limit);
  const lastNewline = slice.lastIndexOf("\n");
  const chosen = lastNewline > limit * 0.4 ? slice.slice(0, lastNewline) : slice;
  return { cut: chosen.trimEnd(), truncated: true };
}

/** The class of a delivered item, restated: the code's form, or relationship-only. */
export function deliveredClass(item: any, slot: "focus" | "related"): string {
  if (slot === "focus") return typeof item?.form === "string" && item.form !== "" ? item.form : "unlabelled";
  if (typeof item?.code !== "string") return RELATIONSHIP_ONLY;
  return typeof item?.form === "string" && item.form !== "" ? item.form : "unlabelled";
}

// -------------------------------------------------------------- the inputs

/** What the driver can establish about the indexed source, per item. */
export interface SourceAuthority {
  /** The indexed file's text, or null when the path is not in the corpus. */
  readonly readFile: (path: string) => string | null;
  /** The index's record for a canonical `path::Symbol`, or null. */
  readonly symbol: (fqName: string, file?: string) => { signature: string; startLine: number; endLine: number; kind: string; localName: string } | null;
  /** The product's own structural skeleton for the symbol, from the index, or null. */
  readonly skeleton: (path: string, fqName: string) => string | null;
}

/** One authoritative supply item as the debug response carries it. */
export interface SupplyItem {
  readonly id: string;
  readonly fqName?: string;
  readonly path?: string;
  readonly contentMode?: string;
  readonly content?: string;
  readonly lineSpan?: { start: number; end: number };
}

export interface Gate { readonly id: string; readonly pass: boolean; readonly detail: string }

export type SourceTruth =
  | "ANCHORED_IN_SPAN" | "ANCHORED_IN_FILE" | "LINEWISE_VERBATIM" | "NOT_LOCATED"
  | "PARSER_SIGNATURE" | "SIGNATURE_NOT_PARSER" | "SKELETON_MATCHES_INDEX" | "SKELETON_HEAD_OF_INDEX" | "SKELETON_DIFFERS"
  | "NOT_APPLICABLE" | "UNCHECKED";

export interface ItemAudit {
  readonly at: string;
  readonly file: string;
  readonly ordinal: number;
  readonly slot: "focus" | "related";
  readonly representation: string;
  readonly frozenClass: string;
  readonly reason: string;
  readonly availableRepresentation: string;
  readonly availableCodeCharacters: number | string;
  readonly codeCharacters: number;
  readonly truncated: boolean;
  readonly sourceTruth: SourceTruth;
  readonly sourceCapability: "code_bearing_body" | "non_code_body" | "no_body" | "neighbour_stripped" | "focus";
  readonly actualTokens: number | null;
  readonly gates: readonly Gate[];
  readonly pass: boolean;
}

export interface RepresentationAnalysis {
  readonly verdict: "REPRESENTATION_INTEGRITY_PASS" | "REPRESENTATION_INTEGRITY_FAIL";
  readonly frozenClasses: readonly string[];
  readonly deliveredClasses: Readonly<Record<string, number>>;
  readonly items: readonly ItemAudit[];
  readonly gates: readonly Gate[];
  /** Tokens of every related entry as delivered, and as it would be with every available form delivered. */
  readonly supply: {
    readonly deliveredRelatedTokens: number;
    readonly representableRelatedTokens: number | null;
    readonly compactRelatedTokens: number;
    readonly relatedWithAvailableForm: number;
    readonly relatedDelivered: number;
  };
}

export interface AnalyzeRepresentationInput {
  readonly packet: any;
  readonly ledger: any;
  readonly ceilingTokens: number;
  readonly relatedBound: number;
  readonly focusBound: number;
  readonly supply?: readonly SupplyItem[] | null;
  readonly authority?: SourceAuthority | null;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Lines of `code` that must occur verbatim in the file: every non-empty line except a product marker line. */
function substantiveLines(code: string, form: string): string[] {
  return code.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0)
    .filter((l) => l.trim() !== EXCERPT_MARKER.trim())
    .filter((l) => !(form === "document_excerpt" && /^Lines \d+-\d+.*:$/.test(l)));
}

/** The evidence budget appends one marker line when it head-bounds a body; it is framing, not text of the body. */
export const withoutMarker = (code: string): string =>
  code.split("\n").filter((l) => l.trim() !== EXCERPT_MARKER.trim()).join("\n").trimEnd();

function spanRegion(file: string, lines: string | null): string | null {
  if (lines === null) return null;
  const m = /^(\d+)-(\d+)$/.exec(lines);
  if (m === null) return null;
  const start = Number.parseInt(m[1]!, 10); const end = Number.parseInt(m[2]!, 10);
  const all = file.split("\n");
  if (start < 1 || end < start || start > all.length) return null;
  return all.slice(start - 1, end).join("\n");
}

/** Hold delivered text to the indexed source: in span, in file, line-wise, or nowhere. */
export function sourceTruthOf(input: {
  readonly form: string; readonly code: string; readonly file: string | null; readonly lines: string | null;
}): SourceTruth {
  if (input.file === null) return "UNCHECKED";
  const code = withoutMarker(input.code);
  const region = spanRegion(input.file, input.lines);
  if (region !== null && region.includes(code)) return "ANCHORED_IN_SPAN";
  if (input.file.includes(code)) return "ANCHORED_IN_FILE";
  const lines = substantiveLines(input.code, input.form);
  if (lines.length > 0 && lines.every((l) => input.file!.includes(l))) return "LINEWISE_VERBATIM";
  return "NOT_LOCATED";
}

/**
 * Hold one response to the representation questions. Every gate is a
 * re-measurement or a structural check; none reads a ledger value and trusts
 * it, and none reads a product function to decide what the product should
 * have done.
 */
export function analyzeRepresentation(input: AnalyzeRepresentationInput): RepresentationAnalysis {
  const packet = input.packet ?? {};
  const ledger = input.ledger;
  const related: any[] = Array.isArray(packet.related) ? packet.related : [];
  const delivered: any[] = [packet.focus, ...related];
  const records: any[] = Array.isArray(ledger?.items) ? ledger.items : [];
  const supplyById = new Map<string, SupplyItem>((input.supply ?? []).map((s) => [String(s.id), s]));
  const gates: Gate[] = [];
  const gate = (id: string, pass: boolean, detail: string) => { gates.push({ id, pass, detail }); };
  const codeBearing = new Set<string>(CODE_BEARING_FORMS_EXPECTED);

  const strip = ({ tokens: _t, ...rest }: any) => rest;
  const stripRepresentation = ({ form: _f, code: _c, codeTruncated: _ct, ...rest }: any) => rest;
  const frame = (focus: any, entries: any[]) => {
    const { related: _r, focus: _f, ...rest } = packet;
    const out: any = { schemaVersion: rest.schemaVersion, focus, related: entries, boundary: rest.boundary };
    if (rest.notes !== undefined) out.notes = rest.notes;
    return out;
  };
  const evidenceFocus = strip(packet.focus ?? {});
  const evidenceRelated = related.map(strip);

  const items: ItemAudit[] = [];
  let representable: number | null = 0;
  let deliveredRelatedTokens = 0; let compactRelatedTokens = 0; let withAvailable = 0;

  for (const [k, item] of delivered.entries()) {
    const slot: "focus" | "related" = k === 0 ? "focus" : "related";
    const record = records[k] ?? {};
    const g: Gate[] = [];
    const ig = (id: string, pass: boolean, detail: string) => { g.push({ id, pass, detail }); };
    const hasForm = typeof item?.form === "string"; const hasCode = typeof item?.code === "string";
    const hasTrunc = typeof item?.codeTruncated === "boolean";
    const representation = deliveredClass(item, slot);
    const reason = String(record.representationReason ?? "");
    const available = record.availableRepresentation;
    const availableChars = record.availableCodeCharacters;
    const code: string = hasCode ? item.code : "";

    // Shape: the three fields travel together, and a relationship-only entry carries none of them.
    if (slot === "focus") {
      ig("fields_consistent", "form" in (item ?? {}) && "code" in (item ?? {}) && hasTrunc, "focus carries form, code and codeTruncated");
    } else {
      ig("fields_consistent", (hasForm && hasCode && hasTrunc) || (!("form" in item) && !("code" in item) && !("codeTruncated" in item)),
        hasCode ? "form, code and codeTruncated present together" : "relationship-only: none of form, code, codeTruncated present");
    }
    ig("class_is_ledger_class", record.representation === representation,
      `packet ${representation} vs ledger ${record.representation}`);
    ig("form_is_code_bearing", !hasCode || slot === "focus" || codeBearing.has(String(item.form)),
      hasCode ? `form ${item.form}` : "no code");
    ig("reason_known", REPRESENTATION_REASONS_EXPECTED.includes(reason), reason || "absent");

    // Routing consistency: the reason must agree with what was delivered and what was available.
    const supplyItem = typeof record.sourceId === "string" ? supplyById.get(record.sourceId) : undefined;
    const body = supplyItem?.content ?? null;
    let capability: ItemAudit["sourceCapability"] = "focus";
    if (slot === "related") {
      if (record.origin === "pivot_neighborhood") capability = "neighbour_stripped";
      else if (record.bodyCharacters === 0 || record.bodyCharacters === "unavailable") capability = "no_body";
      else if (typeof available === "string" && codeBearing.has(available)) capability = "code_bearing_body";
      else capability = "non_code_body";
    }
    if (slot === "focus") {
      ig("reason_consistent", reason === "focus_slot", reason);
    } else if (reason === "upstream_form_delivered") {
      ig("reason_consistent", hasCode && available === item.form && availableChars === code.length,
        `delivered ${item?.form} (${code.length} chars); available ${available} (${availableChars})`);
    } else if (reason === "ceiling") {
      let overCeiling: boolean | null = null;
      if (body !== null && typeof available === "string") {
        const bounded = headBoundRule(body, input.relatedBound);
        const rich = { ...evidenceRelated[k - 1], form: available, code: bounded.cut, codeTruncated: bounded.truncated };
        const trial = evidenceRelated.map((e, j) => (j === k - 1 ? rich : j < k - 1 ? e : stripRepresentation(e)));
        overCeiling = tokensOf(JSON.stringify(frame(evidenceFocus, trial)).length) > input.ceilingTokens;
      }
      ig("reason_consistent", !hasCode && typeof available === "string" && codeBearing.has(available) && isCount(availableChars) && availableChars > 0
        && overCeiling !== false,
        `compact; available ${available} (${availableChars} chars); recomputed over ceiling: ${overCeiling ?? "supply unavailable"}`);
    } else if (reason === "no_rendered_body") {
      ig("reason_consistent", !hasCode && available === "not_applicable" && (record.bodyCharacters === 0 || record.bodyCharacters === "unavailable"),
        `bodyCharacters ${record.bodyCharacters}`);
    } else if (reason === "form_not_code_bearing") {
      ig("reason_consistent", !hasCode && available === "not_applicable" && isCount(record.bodyCharacters) && record.bodyCharacters > 0
        && (supplyItem === undefined || !codeBearing.has(String(supplyItem.contentMode))),
        `bodyCharacters ${record.bodyCharacters}; upstream form ${supplyItem?.contentMode ?? "unavailable"}`);
    } else if (reason === "neighbour_text_not_carried") {
      ig("reason_consistent", !hasCode && record.origin === "pivot_neighborhood" && available === "not_applicable", `origin ${record.origin}`);
    } else {
      ig("reason_consistent", false, `unknown reason ${reason}`);
    }

    // Bound and truncation, against the declared policy and the body. The paired
    // response is a separate call; where its evidence budget rendered the item in
    // a different form than the default call delivered, its body is not the body
    // the projector saw and the two body gates are not comparable.
    const bound = slot === "focus" ? input.focusBound : input.relatedBound;
    ig("bound_respected", code.length <= bound, `${code.length} <= ${bound}`);
    const pairedComparable = body !== null && (supplyItem?.contentMode === undefined || !hasCode || supplyItem.contentMode === item.form);
    if (hasCode && body !== null && !pairedComparable) {
      ig("paired_rendering_comparable", true, `paired response rendered ${supplyItem?.contentMode}, packet delivered ${item.form}: body gates not comparable`);
    }
    if (hasCode && body !== null && pairedComparable) {
      const truncated = item.codeTruncated === true;
      ig("truncation_truthful_against_body", truncated ? (body.startsWith(code) && body.length > code.length) : code === body,
        truncated ? "code is a proper prefix of the body" : "code is the whole body");
      ig("code_is_the_head_bound_of_the_body", headBoundRule(body, bound).cut === code, "head bound recomputed equals delivered code");
    }

    // Source truth against the indexed corpus.
    let truth: SourceTruth = hasCode ? "UNCHECKED" : "NOT_APPLICABLE";
    if (hasCode && input.authority) {
      const form = String(item.form);
      const file = input.authority.readFile(String(item.file));
      if (form === "signature") {
        const symbol = input.authority.symbol(String(item.at), String(item.file));
        if (symbol !== null && symbol.signature === code) truth = "PARSER_SIGNATURE";
        else truth = symbol === null ? "UNCHECKED" : "SIGNATURE_NOT_PARSER";
      } else if (form === "skeleton") {
        const skeleton = input.authority.skeleton(String(item.file), String(item.at));
        const bare = withoutMarker(code);
        if (skeleton === null) truth = "UNCHECKED";
        else if (skeleton === bare) truth = "SKELETON_MATCHES_INDEX";
        // A head of the index skeleton: cut by the projector's bound (codeTruncated) or
        // shortened upstream by the evidence budget. Still index-derived structural text.
        else if (skeleton.startsWith(bare) && skeleton.length > bare.length && bare.length > 0) truth = "SKELETON_HEAD_OF_INDEX";
        else truth = "SKELETON_DIFFERS";
      } else {
        truth = sourceTruthOf({ form, code, file, lines: typeof item.lines === "string" ? item.lines : null });
      }
      ig("source_truth", ["ANCHORED_IN_SPAN", "ANCHORED_IN_FILE", "LINEWISE_VERBATIM", "PARSER_SIGNATURE", "SKELETON_MATCHES_INDEX", "SKELETON_HEAD_OF_INDEX"].includes(truth),
        `${form}: ${truth}`);
    }

    // Provenance: a supply item with this identity, path and span stands behind the entry.
    if (slot === "related" && record.origin === "item_supply") {
      // The paired response's `items` array is the envelope's to compact (M180), so
      // below ~6000 tokens a supply item may survive only as its rendered section:
      // id and body, no identity fields. Identity is then held to what survived.
      const identityKnown = supplyItem !== undefined && (supplyItem.fqName !== undefined || supplyItem.path !== undefined);
      ig("provenance", supplyItem === undefined || !identityKnown
        ? typeof record.sourceId === "string" && record.sourceId !== "unavailable"
        : (supplyItem.fqName === undefined || supplyItem.fqName === item.at) && (supplyItem.path === undefined || supplyItem.path === item.file),
        supplyItem === undefined ? `sourceId ${record.sourceId} (supply not bound)`
          : !identityKnown ? `sourceId ${record.sourceId} (section ${supplyItem.id}; identity compacted out of the paired response)`
            : `supply ${supplyItem.id} ${supplyItem.fqName ?? supplyItem.path}`);
    }

    const actual = isCount(item?.tokens) ? item.tokens : null;
    if (slot === "related") {
      deliveredRelatedTokens += actual ?? 0;
      compactRelatedTokens += tokensOf(JSON.stringify({ ...stripRepresentation(strip(item)), tokens: 0 }).length);
      if (typeof available === "string" && codeBearing.has(available)) {
        withAvailable += 1;
        if (hasCode) representable = representable === null ? null : representable + (actual ?? 0);
        else if (body !== null) {
          const bounded = headBoundRule(body, input.relatedBound);
          const rich = { ...stripRepresentation(strip(item)), form: available, code: bounded.cut, codeTruncated: bounded.truncated, tokens: 0 };
          representable = representable === null ? null : representable + tokensOf(JSON.stringify(rich).length);
        } else representable = null;
      } else representable = representable === null ? null : representable + (actual ?? 0);
    }

    items.push({
      at: String(item?.at ?? ""), file: String(item?.file ?? ""), ordinal: k, slot, representation, frozenClass: frozenRepresentationClass(item, slot),
      reason, availableRepresentation: String(available ?? "absent"), availableCodeCharacters: availableChars ?? "absent",
      codeCharacters: code.length, truncated: item?.codeTruncated === true, sourceTruth: truth, sourceCapability: capability,
      actualTokens: actual, gates: g, pass: g.every((x) => x.pass),
    });
  }

  // Corpus-of-one gates.
  const ids = delivered.map((d) => String(d?.at ?? ""));
  gate("no_duplicate_identity", new Set(ids).size === ids.length && ids.every((id) => id.length > 0), `${ids.length - new Set(ids).size} duplicates`);
  gate("every_item_passes", items.every((i) => i.pass), `${items.filter((i) => !i.pass).length} items failing`);
  const accounting = ledger ? analyzeAccounting({ packet, ledger, ceilingTokens: input.ceilingTokens }) : null;
  gate("m203_accounting", accounting?.verdict === "ACCOUNTING_INTEGRITY_PASS",
    accounting === null ? "no ledger" : accounting.gates.filter((x) => !x.pass).map((x) => x.id).join(",") || "passes");
  gate("admission_figures_monotone", records.every((r, k) => k === 0 || r.admissionPacketTokens >= records[k - 1].admissionPacketTokens)
    && records.every((r) => isCount(r.compactAdmissionPacketTokens) && r.compactAdmissionPacketTokens <= r.admissionPacketTokens),
    "representation figures non-decreasing and never below the compact admission figure");
  gate("ceiling_honoured", ledger?.evidence?.tokens <= input.ceilingTokens || related.length === 0,
    `evidence ${ledger?.evidence?.tokens} vs ceiling ${input.ceilingTokens}`);
  // The compact projection of the delivered packet: what admission tested.
  const compactPacket = frame(evidenceFocus, evidenceRelated.map(stripRepresentation));
  gate("compact_packet_within_ceiling", tokensOf(JSON.stringify(compactPacket).length) <= input.ceilingTokens || related.length === 0,
    `${tokensOf(JSON.stringify(compactPacket).length)} vs ${input.ceilingTokens}`);

  const deliveredClasses: Record<string, number> = {};
  for (const i of items) deliveredClasses[i.representation] = (deliveredClasses[i.representation] ?? 0) + 1;

  return {
    verdict: gates.every((x) => x.pass) ? "REPRESENTATION_INTEGRITY_PASS" : "REPRESENTATION_INTEGRITY_FAIL",
    frozenClasses: frozenA12Classes(packet),
    deliveredClasses, items, gates,
    supply: { deliveredRelatedTokens, representableRelatedTokens: representable, compactRelatedTokens,
      relatedWithAvailableForm: withAvailable, relatedDelivered: related.length },
  };
}

/**
 * Class distinction over a corpus: two classes are distinct when their
 * construction rules produce different text for at least one item on which
 * both are computable. A leaf function's skeleton IS its signature — that is
 * a fact about the function, not a collapse of the classes — so the gate asks
 * whether the classes EVER differ, and reports how often they coincide.
 */
export function classDistinction(pairs: readonly { a: string; b: string; textA: string | null; textB: string | null }[]): {
  readonly pairs: readonly { pair: string; comparable: number; distinct: number; coincident: number; distinctOnSomeItem: boolean }[];
  readonly pass: boolean;
} {
  const byPair = new Map<string, { comparable: number; distinct: number }>();
  for (const p of pairs) {
    if (p.textA === null || p.textB === null) continue;
    const key = `${p.a}|${p.b}`;
    const entry = byPair.get(key) ?? { comparable: 0, distinct: 0 };
    entry.comparable += 1; if (p.textA !== p.textB) entry.distinct += 1;
    byPair.set(key, entry);
  }
  const out = [...byPair.entries()].map(([pair, v]) => ({ pair, comparable: v.comparable, distinct: v.distinct,
    coincident: v.comparable - v.distinct, distinctOnSomeItem: v.distinct > 0 }));
  return { pairs: out, pass: out.every((p) => p.distinctOnSomeItem) };
}
