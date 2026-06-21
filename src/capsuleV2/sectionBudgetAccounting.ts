// Section-level budget / truncation accounting for the rendered VTRACE capsule
// context (M44-ACCT).
//
// The downstream Stage 5 injector truncates the *whole* rendered capsule to a
// single global char budget (`truncateContext`, head-preserving, section-blind).
// When an optional advisory section (e.g. the M39 Semantic Edit Hypothesis or the
// M41 Edit-Sufficiency Checklist) pushes the render over budget, the head-preserving
// cut can clip the TAIL — which is where essential source evidence (the pivot
// neighborhood) lives. The M42 sphinx-7462 treatment did exactly this: optional
// advisory text survived while 752 chars of the essential pivot-neighborhood block
// were evicted.
//
// This module is PURE, ANALYSIS-ONLY telemetry. It parses the already-rendered text
// into sections, classifies each by priority, and — given the same char budget the
// injector uses — reports which sections survive, which are clipped, and crucially
// whether an ESSENTIAL section was evicted while an OPTIONAL one was retained. It
// changes NO retrieval, ranking, pivots, scoring, or injected text: it only measures.

/** Priority class for a rendered capsule section (see M44-ACCT inventory). */
export type SectionPriority = "essential" | "important" | "optional" | "diagnostic";

/** The kind of block a section came from. */
export type SectionKind = "framing" | "heading" | "pivot" | "support";

/** One parsed section of the rendered capsule, with its byte span and priority. */
export interface RenderedSection {
  /** Heading text (without the leading `## `), or a synthetic name for item blocks. */
  readonly name: string;
  readonly kind: SectionKind;
  readonly priority: SectionPriority;
  /** Character offset of this section's first char within the rendered text. */
  readonly startChar: number;
  /** Length (chars) of this section's block, up to the next section start. */
  readonly chars: number;
}

/** Result of analysing the rendered text against the injector's char budget. */
export interface SectionTruncationAnalysis {
  /** Full rendered size before truncation. */
  readonly preTruncationChars: number;
  /**
   * Size of the retained prefix after truncation (== `maxChars` when truncated,
   * else == `preTruncationChars`). Excludes the appended `[truncated to N chars]`
   * marker the injector adds — this is the count of ACTUAL capsule text retained.
   */
  readonly postTruncationChars: number;
  /** Chars dropped by the cut (`preTruncationChars - postTruncationChars`). */
  readonly truncatedChars: number;
  readonly truncationOccurred: boolean;
  /** Every parsed section, in render order. */
  readonly sections: readonly RenderedSection[];
  /** Names of sections that lost any chars to the cut (partly clipped or fully evicted). */
  readonly truncatedSectionNames: readonly string[];
  /** Names of sections that began at or after the cut (entirely removed). */
  readonly fullyEvictedSectionNames: readonly string[];
  /** Essential sections that lost any chars to the cut — the dangerous case. */
  readonly essentialSectionsEvicted: readonly string[];
  /** Optional sections fully retained while something essential was evicted, etc. */
  readonly optionalSectionsRetained: readonly string[];
}

// Ordered classification rules. The FIRST rule whose substring is found in the
// (case-insensitive) section name wins. Unknown `##` headings default to
// "important" — conservative: never silently treat an unrecognised section as
// safe-to-drop. Item blocks (●/○) are classified by kind, not by these rules.
const HEADING_RULES: ReadonlyArray<{ readonly match: string; readonly priority: SectionPriority }> = [
  // optional advisory / explanatory scaffolding (safe to drop first)
  { match: "semantic edit hypothesis", priority: "optional" },
  { match: "edit-sufficiency check", priority: "optional" },
  { match: "edit sufficiency check", priority: "optional" },
  { match: "multi-pivot action plan", priority: "optional" },
  // diagnostic / provenance
  { match: "accounting", priority: "diagnostic" },
  { match: "provenance", priority: "diagnostic" },
  { match: "debug", priority: "diagnostic" },
  // essential source / flow evidence
  { match: "pivot neighborhood", priority: "essential" },
  { match: "inspect-first", priority: "essential" },
  // important obligations / hints / guidance
  { match: "pivot inspection contract", priority: "important" },
  { match: "actionability hints", priority: "important" },
  { match: "multiple edit targets", priority: "important" },
  { match: "edit risk", priority: "important" },
  { match: "co-edit", priority: "important" },
];

/** Classify a `## ` heading section by its (heading) name. */
export function classifyHeading(name: string): SectionPriority {
  const lower = name.toLowerCase();
  for (const rule of HEADING_RULES) {
    if (lower.includes(rule.match)) return rule.priority;
  }
  return "important";
}

// A pivot's focused source is the primary edit evidence; support bodies are
// edit-relevant source too. Both are essential — they are exactly the code
// evidence the capsule exists to preserve.
const ITEM_PRIORITY: SectionPriority = "essential";

function isHeadingLine(line: string): boolean {
  return line.startsWith("## ");
}

// Item blocks rendered by renderItem.itemBlockText start with a filled (pivot) or
// hollow (support) bullet followed by the role and `path::symbol`.
function itemMatch(line: string): { kind: "pivot" | "support"; rest: string } | null {
  if (line.startsWith("● pivot ")) return { kind: "pivot", rest: line.slice("● pivot ".length) };
  if (line.startsWith("○ support ")) return { kind: "support", rest: line.slice("○ support ".length) };
  return null;
}

/**
 * Parse the rendered capsule text into priority-classified sections.
 *
 * A new section starts at each `## ` heading or each `●/○ pivot|support` item
 * block. Any leading content before the first such boundary (the intent / strategy
 * / budget framing) is captured as a single essential "framing" section. Section
 * char spans are contiguous and cover the whole text, so summing `chars` reproduces
 * `text.length`.
 */
export function inventorySections(text: string): RenderedSection[] {
  const lines = text.split("\n");
  // Precompute each line's start offset (account for the "\n" join chars).
  const lineStart: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStart.push(offset);
    offset += line.length + 1; // +1 for the "\n" that join reinserts
  }
  // The rendered text has no trailing newline after the last line, so the total
  // length is offset - 1 (when there is at least one line).
  const totalChars = lines.length > 0 ? offset - 1 : 0;

  type Boundary = { index: number; name: string; kind: SectionKind; priority: SectionPriority };
  const boundaries: Boundary[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isHeadingLine(line)) {
      const name = line.slice(3).trim();
      boundaries.push({ index: i, name, kind: "heading", priority: classifyHeading(name) });
      continue;
    }
    const item = itemMatch(line);
    if (item !== null) {
      boundaries.push({
        index: i,
        name: `${item.kind} source: ${item.rest.trim()}`,
        kind: item.kind,
        priority: ITEM_PRIORITY,
      });
    }
  }

  const sections: RenderedSection[] = [];
  // Leading framing block before the first boundary (if any non-empty content).
  const firstBoundaryLine = boundaries.length > 0 ? boundaries[0].index : lines.length;
  if (firstBoundaryLine > 0) {
    const framingText = lines.slice(0, firstBoundaryLine).join("\n");
    if (framingText.trim().length > 0) {
      sections.push({
        name: "task framing (intent/strategy/budget)",
        kind: "framing",
        priority: "essential",
        startChar: 0,
        chars: framingText.length,
      });
    }
  }
  for (let b = 0; b < boundaries.length; b += 1) {
    const start = lineStart[boundaries[b].index];
    const end = b + 1 < boundaries.length ? lineStart[boundaries[b + 1].index] : totalChars + 1;
    // The block runs from this boundary's line start up to (but not including) the
    // next boundary's line start; trim the trailing join "\n" for the last block.
    const chars = Math.max(0, Math.min(end, totalChars) - start);
    sections.push({
      name: boundaries[b].name,
      kind: boundaries[b].kind,
      priority: boundaries[b].priority,
      startChar: start,
      chars,
    });
  }
  return sections;
}

/**
 * Analyse how the injector's global, head-preserving char-budget truncation
 * (`truncateContext`, slicing to `maxChars`) would carve up the rendered text by
 * section. Mirrors the injector's behaviour: keep the first `maxChars` chars, drop
 * the rest. Reports which sections lose chars and — the headline signal — whether
 * any ESSENTIAL section is clipped while OPTIONAL sections survive intact.
 */
export function analyzeSectionTruncation(text: string, maxChars: number): SectionTruncationAnalysis {
  const sections = inventorySections(text);
  const preTruncationChars = text.length;
  const cut = Math.max(0, maxChars);
  const truncationOccurred = preTruncationChars > cut;
  const postTruncationChars = truncationOccurred ? cut : preTruncationChars;
  const truncatedChars = preTruncationChars - postTruncationChars;

  const truncatedSectionNames: string[] = [];
  const fullyEvictedSectionNames: string[] = [];
  const essentialSectionsEvicted: string[] = [];
  for (const section of sections) {
    const sectionEnd = section.startChar + section.chars;
    const losesChars = truncationOccurred && sectionEnd > cut;
    const fullyEvicted = truncationOccurred && section.startChar >= cut;
    if (losesChars) {
      truncatedSectionNames.push(section.name);
      if (section.priority === "essential") essentialSectionsEvicted.push(section.name);
    }
    if (fullyEvicted) fullyEvictedSectionNames.push(section.name);
  }

  // Optional sections fully retained — only interesting (and only reported) when an
  // essential section was evicted, i.e. the renderer kept droppable text and lost
  // code evidence. Empty otherwise, so a clean (untruncated or essential-safe) run
  // reports no false alarm.
  const optionalSectionsRetained: string[] = [];
  if (essentialSectionsEvicted.length > 0) {
    for (const section of sections) {
      const sectionEnd = section.startChar + section.chars;
      const fullyRetained = sectionEnd <= cut;
      if (section.priority === "optional" && fullyRetained) {
        optionalSectionsRetained.push(section.name);
      }
    }
  }

  return {
    preTruncationChars,
    postTruncationChars,
    truncatedChars,
    truncationOccurred,
    sections,
    truncatedSectionNames,
    fullyEvictedSectionNames,
    essentialSectionsEvicted,
    optionalSectionsRetained,
  };
}

// ---------------------------------------------------------------------------------
// M45: section-priority truncation.
//
// Reducing an over-budget render WITHOUT clipping essential evidence. Instead of the
// section-blind head-preserving slice, drop whole non-essential sections — diagnostic
// first, then optional, then important — until the render fits, replacing each dropped
// section with a one-line omission marker. Essential sections (framing, pivot/support
// source, pivot-neighborhood) are preserved as long as possible; only if the essential
// sections ALONE still exceed the budget does it fall back to the legacy slice, and it
// reports `essentialSectionsEvicted=true` when that happens. The invariant: an optional
// section is never retained in full while an essential section is clipped.

/** Section-level budget telemetry for the injected VTRACE context (additive). */
export interface VtraceContextBudget {
  readonly maxChars: number;
  readonly preTruncationChars: number;
  /** Length of the ACTUAL injected text after reduction (incl. any markers). */
  readonly postTruncationChars: number;
  /** Net chars removed (`preTruncationChars - postTruncationChars`). */
  readonly truncatedChars: number;
  readonly truncationOccurred: boolean;
  readonly truncationMode:
    | "none"
    | "section_priority"
    | "legacy_slice_fallback"
    // M61 — atomic-block-preserving modes (used only when `atomicBlocks` is supplied
    // and at least one sentinel block is present in the text):
    | "atomic_section_priority"  // free content shed by priority; atomic blocks whole
    | "atomic_legacy_slice"      // free content head-clipped; atomic blocks still whole
    | "atomic_omitted";          // an atomic block could not fit — failed CLOSED
  /** Sections dropped whole and replaced by an omission marker, in render order. */
  readonly droppedSectionNames: readonly string[];
  /** Sections clipped mid-block by the legacy-slice fallback (empty otherwise). */
  readonly truncatedSectionNames: readonly string[];
  /** True only when the fallback clipped an essential section. */
  readonly essentialSectionsEvicted: boolean;
  readonly optionalSectionsDropped: boolean;
  /** Optional sections retained in full (should be empty whenever essential evicted). */
  readonly optionalSectionsRetained: readonly string[];
  /**
   * M61 — labels of atomic sentinel blocks (digest / decision contract) that were
   * preserved WHOLE through truncation. Undefined on the non-atomic (default) path.
   */
  readonly atomicBlocksPreserved?: readonly string[];
  /**
   * M61 — labels of atomic blocks that could NOT fit even after evicting every
   * lower-priority section; each is replaced by an explicit omission marker rather
   * than a partial sentinel block. Undefined on the non-atomic path; empty in the
   * normal (success) atomic path.
   */
  readonly atomicBlocksOmitted?: readonly string[];
}

export interface SectionPriorityTruncation {
  /** The actual text to inject (reduced when over budget, unchanged otherwise). */
  readonly text: string;
  /** Non-empty line count of `text` (mirrors truncateContext's item notion). */
  readonly items: number;
  readonly budget: VtraceContextBudget;
}

// Lowest-value sections are sacrificed first. Essential is never in this list.
const DROP_ORDER: readonly SectionPriority[] = ["diagnostic", "optional", "important"];

function omissionMarker(section: RenderedSection): string {
  return `[omitted ${section.priority} section: ${section.name} (${section.chars} chars)]`;
}

function countNonEmptyLines(text: string): number {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * M61 — one sentinel-delimited block that must survive truncation whole (or be
 * omitted with an explicit marker — never left as a partial sentinel pair).
 */
export interface AtomicSentinelBlockSpec {
  /** Stable label used in telemetry / omission markers (e.g. "capsule_v2_digest"). */
  readonly label: string;
  /** Opening sentinel literal, e.g. "<VTRACE_CAPSULE_V2_DIGEST_START>". */
  readonly start: string;
  /** Closing sentinel literal, e.g. "<VTRACE_CAPSULE_V2_DIGEST_END>". */
  readonly end: string;
}

/** Options for {@link truncateContextByPriority}. Absent ⇒ exact pre-M61 behavior. */
export interface TruncateByPriorityOptions {
  /**
   * M61 — sentinel blocks (digest / decision contract) to preserve ATOMICALLY. Only
   * blocks whose BOTH sentinels are actually present (START before END) activate the
   * atomic path; if none are present the function is byte-identical to the default.
   */
  readonly atomicBlocks?: readonly AtomicSentinelBlockSpec[];
}

/**
 * M61 — explicit marker emitted in place of an atomic block that genuinely cannot fit
 * the budget. Kept OUTSIDE any sentinel pair so a validator never sees a partial block.
 */
export const STRUCTURED_CONTRACT_OMITTED_MARKER = "VTRACE_STRUCTURED_CONTRACT_OMITTED_DUE_TO_BUDGET";

/**
 * Reduce `text` to fit `maxChars` by dropping whole non-essential sections in priority
 * order (diagnostic → optional → important, largest-first within a class), preserving
 * essential evidence. Falls back to a head-preserving slice (with the legacy
 * `[truncated to N chars]` marker) only when the essential sections alone exceed the
 * budget. PURE: no retrieval/ranking/scoring/render-content change.
 *
 * M61 — when `options.atomicBlocks` names sentinel blocks that are present in `text`,
 * those blocks are reserved WHOLE and only the surrounding (free) content is reduced,
 * so the structured bounded digest + decision contract are never split by truncation.
 * Without `atomicBlocks` (or when none are present) the original behavior is preserved
 * exactly.
 */
export function truncateContextByPriority(
  text: string,
  maxChars: number,
  options?: TruncateByPriorityOptions,
): SectionPriorityTruncation {
  const atomicSpecs = options?.atomicBlocks ?? [];
  if (atomicSpecs.length > 0) {
    const locked = locateAtomicBlocks(text, atomicSpecs);
    if (locked.length > 0) return truncatePreservingAtomicBlocks(text, maxChars, locked);
  }
  return truncateContextByPriorityCore(text, maxChars);
}

/** The pre-M61 section-priority reducer. Unchanged behavior; now the non-atomic core. */
function truncateContextByPriorityCore(text: string, maxChars: number): SectionPriorityTruncation {
  const cut = Math.max(0, maxChars);
  const preTruncationChars = text.length;

  const noop = (mode: VtraceContextBudget["truncationMode"]): SectionPriorityTruncation => ({
    text,
    items: countNonEmptyLines(text),
    budget: {
      maxChars: cut,
      preTruncationChars,
      postTruncationChars: preTruncationChars,
      truncatedChars: 0,
      truncationOccurred: false,
      truncationMode: mode,
      droppedSectionNames: [],
      truncatedSectionNames: [],
      essentialSectionsEvicted: false,
      optionalSectionsDropped: false,
      optionalSectionsRetained: [],
    },
  });

  if (preTruncationChars <= cut) return noop("none");

  const sections = inventorySections(text);
  const kept = sections.map(() => true);
  const sliceOf = (i: number): string =>
    text.slice(sections[i].startChar, sections[i].startChar + sections[i].chars);
  const markerOf = (i: number): string => `${omissionMarker(sections[i])}\n`;

  // Project the post-reduction length as we drop sections (kept→chars, dropped→marker).
  let projected = preTruncationChars;
  for (const cls of DROP_ORDER) {
    if (projected <= cut) break;
    const candidates = sections
      .map((section, index) => ({ section, index }))
      .filter(({ section }) => section.priority === cls)
      .sort((a, b) => b.section.chars - a.section.chars || a.section.startChar - b.section.startChar)
      .map(({ index }) => index);
    for (const index of candidates) {
      if (projected <= cut) break;
      kept[index] = false;
      projected = projected - sections[index].chars + markerOf(index).length;
    }
  }

  // Rebuild, tracking each section's span in the rebuilt text (for fallback reporting).
  const parts: string[] = [];
  const spans: Array<{ name: string; priority: SectionPriority; start: number; end: number; kept: boolean }> = [];
  let pos = 0;
  for (let i = 0; i < sections.length; i += 1) {
    const piece = kept[i] ? sliceOf(i) : markerOf(i);
    parts.push(piece);
    spans.push({ name: sections[i].name, priority: sections[i].priority, start: pos, end: pos + piece.length, kept: kept[i] });
    pos += piece.length;
  }
  const rebuilt = parts.join("");

  const droppedSectionNames = sections.filter((_s, i) => !kept[i]).map((s) => s.name);
  const optionalSectionsDropped = sections.some((s, i) => !kept[i] && s.priority === "optional");
  const optionalSectionsRetained = sections.filter((s, i) => kept[i] && s.priority === "optional").map((s) => s.name);

  if (rebuilt.length <= cut) {
    return {
      text: rebuilt,
      items: countNonEmptyLines(rebuilt),
      budget: {
        maxChars: cut,
        preTruncationChars,
        postTruncationChars: rebuilt.length,
        truncatedChars: preTruncationChars - rebuilt.length,
        truncationOccurred: true,
        truncationMode: "section_priority",
        droppedSectionNames,
        truncatedSectionNames: [],
        essentialSectionsEvicted: false,
        optionalSectionsDropped,
        optionalSectionsRetained,
      },
    };
  }

  // Fallback: essentials alone still exceed the budget — head-preserving slice, with
  // the same legacy marker the old truncateContext emitted. Essential evidence is clipped.
  const finalText = `${rebuilt.slice(0, cut)}\n[truncated to ${cut} chars]`;
  const truncatedSectionNames = spans.filter((sp) => sp.kept && sp.end > cut).map((sp) => sp.name);
  const essentialSectionsEvicted = spans.some((sp) => sp.kept && sp.priority === "essential" && sp.end > cut);
  return {
    text: finalText,
    items: countNonEmptyLines(finalText),
    budget: {
      maxChars: cut,
      preTruncationChars,
      postTruncationChars: finalText.length,
      truncatedChars: preTruncationChars - finalText.length,
      truncationOccurred: true,
      truncationMode: "legacy_slice_fallback",
      droppedSectionNames,
      truncatedSectionNames,
      essentialSectionsEvicted,
      optionalSectionsDropped,
      // After fallback every non-essential is dropped, so nothing optional is "retained".
      optionalSectionsRetained: [],
    },
  };
}

// ---------------------------------------------------------------------------------
// M61: atomic sentinel-block preservation under truncation.
//
// The structured bounded treatment injects two sentinel-delimited blocks that MUST
// reach the agent whole — the Capsule v2 digest (<VTRACE_CAPSULE_V2_DIGEST_*>) and the
// decision contract (<VTRACE_DIGEST_DECISION_CONTRACT_*>). The section-blind legacy
// slice (`truncateContextByPriorityCore`'s fallback) could clip the TAIL of the render
// and evict the contract END sentinel (M60B pylint-8898), leaving a dangling START with
// no END — a PARTIAL sentinel pair the strict four-sentinel validator rightly rejects.
//
// The fix reserves the atomic blocks OUTSIDE the reducer: locked spans are emitted
// verbatim, and only the surrounding FREE content is reduced (via the same priority
// reducer, so the duplicate human render / neighborhood is shed before the atomic blocks
// are ever touched). The invariant — a sentinel block is either fully present or fully
// absent with an explicit omission marker — therefore holds by CONSTRUCTION, not repair.

/** A located atomic block: its label and the half-open `[start, end)` char span. */
interface LockedSpan {
  readonly label: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Locate each spec's atomic block (START before its matching END). Specs whose
 * sentinels are not both present are skipped (the block is simply absent). Returns
 * non-overlapping spans sorted by start offset (an overlapping later span is dropped,
 * defensively — well-formed digest/contract blocks never overlap).
 */
function locateAtomicBlocks(text: string, specs: readonly AtomicSentinelBlockSpec[]): LockedSpan[] {
  const found: LockedSpan[] = [];
  for (const spec of specs) {
    const s = text.indexOf(spec.start);
    if (s < 0) continue;
    const e = text.indexOf(spec.end, s + spec.start.length);
    if (e < 0) continue;
    found.push({ label: spec.label, start: s, end: e + spec.end.length });
  }
  found.sort((a, b) => a.start - b.start);
  const out: LockedSpan[] = [];
  let lastEnd = -1;
  for (const span of found) {
    if (span.start >= lastEnd) {
      out.push(span);
      lastEnd = span.end;
    }
  }
  return out;
}

/**
 * Reduce `text` to `maxChars` while preserving every locked block whole. Reserves the
 * locked spans, reduces the surrounding free content with the standard section-priority
 * reducer, and fails CLOSED (explicit omission marker, never a partial sentinel) only if
 * the locked blocks alone exceed the budget. PURE.
 */
function truncatePreservingAtomicBlocks(
  text: string,
  maxChars: number,
  locked: readonly LockedSpan[],
): SectionPriorityTruncation {
  const cut = Math.max(0, maxChars);
  const preTruncationChars = text.length;
  const labels = locked.map((l) => l.label);

  // Whole text already fits — keep everything, report the atomic blocks preserved.
  if (preTruncationChars <= cut) {
    return {
      text,
      items: countNonEmptyLines(text),
      budget: {
        maxChars: cut,
        preTruncationChars,
        postTruncationChars: preTruncationChars,
        truncatedChars: 0,
        truncationOccurred: false,
        truncationMode: "none",
        droppedSectionNames: [],
        truncatedSectionNames: [],
        essentialSectionsEvicted: false,
        optionalSectionsDropped: false,
        optionalSectionsRetained: [],
        atomicBlocksPreserved: labels,
        atomicBlocksOmitted: [],
      },
    };
  }

  const lockedChars = locked.reduce((n, l) => n + (l.end - l.start), 0);

  // Fail CLOSED: the atomic blocks alone cannot fit. Keep blocks greedily (in order)
  // until the budget is exhausted; replace each block that cannot fit with an explicit
  // omission marker — NEVER a partial sentinel pair — and drop all free content. This is
  // expected to be rare (digest + contract are a few KB; the budget is ~12 KB).
  if (lockedChars > cut) {
    const preserved: string[] = [];
    const omitted: string[] = [];
    const parts: string[] = [];
    let used = 0;
    for (const l of locked) {
      const block = text.slice(l.start, l.end);
      const sep = parts.length > 0 ? 2 : 0; // a "\n\n" join between emitted parts
      if (used + sep + block.length <= cut) {
        if (parts.length > 0) parts.push("\n\n");
        parts.push(block);
        used += sep + block.length;
        preserved.push(l.label);
      } else {
        const marker = `${STRUCTURED_CONTRACT_OMITTED_MARKER} (${l.label})`;
        if (parts.length > 0) parts.push("\n\n");
        parts.push(marker);
        used += sep + marker.length;
        omitted.push(l.label);
      }
    }
    const finalText = parts.join("");
    return {
      text: finalText,
      items: countNonEmptyLines(finalText),
      budget: {
        maxChars: cut,
        preTruncationChars,
        postTruncationChars: finalText.length,
        truncatedChars: preTruncationChars - finalText.length,
        truncationOccurred: true,
        truncationMode: "atomic_omitted",
        droppedSectionNames: [],
        truncatedSectionNames: [],
        essentialSectionsEvicted: true,
        optionalSectionsDropped: false,
        optionalSectionsRetained: [],
        atomicBlocksPreserved: preserved,
        atomicBlocksOmitted: omitted,
      },
    };
  }

  // Normal atomic path: reserve the locked blocks, reduce the FREE content to the
  // remaining budget. Build the ordered free/locked segment list (it covers the whole
  // text contiguously, so concatenating the segments reproduces `text`).
  type Seg = { readonly kind: "free" | "locked"; readonly text: string };
  const segs: Seg[] = [];
  let cursor = 0;
  for (const l of locked) {
    if (l.start > cursor) segs.push({ kind: "free", text: text.slice(cursor, l.start) });
    segs.push({ kind: "locked", text: text.slice(l.start, l.end) });
    cursor = l.end;
  }
  if (cursor < text.length) segs.push({ kind: "free", text: text.slice(cursor) });

  // Whitespace-only free segments (e.g. the "\n\n" between digest and contract) are kept
  // verbatim — they are negligible and dropping them would visually fuse the blocks. The
  // remaining (content) free budget is split across content free segments in proportion
  // to their size; the LAST content segment absorbs the rounding remainder. For the real
  // single-trailing-free-segment layout this is exact.
  const freeBudget = cut - lockedChars;
  const wsChars = segs
    .filter((s) => s.kind === "free" && s.text.trim().length === 0)
    .reduce((n, s) => n + s.text.length, 0);
  const contentSegs = segs.filter((s) => s.kind === "free" && s.text.trim().length > 0);
  // The core reducer's head-clip fallback appends a `\n[truncated to N chars]` marker, so
  // a clipped free segment can exceed its own budget by the marker length. Reserve that
  // overhead per content segment so the assembled total still respects `cut` (the locked
  // blocks are never clipped, so the only overshoot risk is these free markers).
  const MARKER_RESERVE = 32;
  const contentFreeBudget = Math.max(0, freeBudget - wsChars - contentSegs.length * MARKER_RESERVE);
  const totalContentFree = contentSegs.reduce((n, s) => n + s.text.length, 0);

  const droppedSectionNames: string[] = [];
  const truncatedSectionNames: string[] = [];
  let anyClip = false;
  let optionalDropped = false;
  let contentSeen = 0;
  let budgetAssigned = 0;

  const rebuilt = segs.map((seg) => {
    if (seg.kind === "locked") return seg.text;
    if (seg.text.trim().length === 0) return seg.text; // whitespace-only separator, kept
    if (totalContentFree === 0) return seg.text;
    contentSeen += seg.text.length;
    const isLast = contentSeen === totalContentFree;
    const segBudget = isLast
      ? Math.max(0, contentFreeBudget - budgetAssigned)
      : Math.floor((contentFreeBudget * seg.text.length) / totalContentFree);
    budgetAssigned += segBudget;
    const reduced = truncateContextByPriorityCore(seg.text, segBudget);
    droppedSectionNames.push(...reduced.budget.droppedSectionNames);
    truncatedSectionNames.push(...reduced.budget.truncatedSectionNames);
    if (reduced.budget.truncationMode === "legacy_slice_fallback") anyClip = true;
    if (reduced.budget.essentialSectionsEvicted) anyClip = true;
    if (reduced.budget.optionalSectionsDropped) optionalDropped = true;
    return reduced.text;
  });

  const finalText = rebuilt.join("");
  return {
    text: finalText,
    items: countNonEmptyLines(finalText),
    budget: {
      maxChars: cut,
      preTruncationChars,
      postTruncationChars: finalText.length,
      truncatedChars: preTruncationChars - finalText.length,
      truncationOccurred: true,
      // The atomic blocks are preserved either way; the mode reflects whether the
      // surrounding free content was shed cleanly or had to be head-clipped.
      truncationMode: anyClip ? "atomic_legacy_slice" : "atomic_section_priority",
      droppedSectionNames,
      truncatedSectionNames,
      // `essentialSectionsEvicted` here means lower-priority free SOURCE was clipped — the
      // atomic digest/contract blocks themselves are always whole (see atomicBlocksPreserved).
      essentialSectionsEvicted: anyClip,
      optionalSectionsDropped: optionalDropped,
      optionalSectionsRetained: [],
      atomicBlocksPreserved: labels,
      atomicBlocksOmitted: [],
    },
  };
}
