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
  readonly truncationMode: "none" | "section_priority" | "legacy_slice_fallback";
  /** Sections dropped whole and replaced by an omission marker, in render order. */
  readonly droppedSectionNames: readonly string[];
  /** Sections clipped mid-block by the legacy-slice fallback (empty otherwise). */
  readonly truncatedSectionNames: readonly string[];
  /** True only when the fallback clipped an essential section. */
  readonly essentialSectionsEvicted: boolean;
  readonly optionalSectionsDropped: boolean;
  /** Optional sections retained in full (should be empty whenever essential evicted). */
  readonly optionalSectionsRetained: readonly string[];
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
 * Reduce `text` to fit `maxChars` by dropping whole non-essential sections in priority
 * order (diagnostic → optional → important, largest-first within a class), preserving
 * essential evidence. Falls back to a head-preserving slice (with the legacy
 * `[truncated to N chars]` marker) only when the essential sections alone exceed the
 * budget. PURE: no retrieval/ranking/scoring/render-content change.
 */
export function truncateContextByPriority(text: string, maxChars: number): SectionPriorityTruncation {
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
