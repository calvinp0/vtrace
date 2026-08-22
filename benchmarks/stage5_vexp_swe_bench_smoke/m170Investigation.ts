/**
 * M170-A/B — the ordinary investigation surface, and what could sit underneath it.
 *
 * M169 closed the proactive architecture: a mandatory pipeline payload cost
 * $0.0985 per task and displaced $0.0026 of investigation. M170 asks the
 * opposite question — whether VTRACE can sit BENEATH an operation the agent
 * already chose to issue, so that the same ordinary action returns less.
 *
 * That question is only answerable against what agents actually did, so the
 * unit here is one native tool call from a captured baseline transcript, not a
 * task and not a hypothesised workflow.
 *
 * Three capture facts drive the design:
 *
 *   1. `_tool_calls_with_outputs.json` TRUNCATES every captured output at 8192
 *      characters. Reading investigation cost from it understates the largest
 *      operations by up to 3x — django-13658's one Read is 18,551 characters,
 *      not the 8,192 the capture stores. This module parses the raw stream.
 *
 *   2. Tool calls are paired to their results by `tool_use_id`, not by sibling
 *      order. Order-based pairing is correct only while every request issues
 *      its tools in result order, which is an assumption, not a guarantee.
 *
 *   3. A tool result carrying the harness's own `<system-reminder>` banner is
 *      not the same object as the file content. The banner is the harness
 *      telling the truth about a partial view, and M170 must be able to see
 *      when it is present and when a mediation would remove it.
 *
 * PURE. No I/O, no clock, no network.
 */

// ── what the agent was trying to learn ──────────────────────────────

export const OperationIntent = Object.freeze({
  /** A search for a named definition. The answer wanted is "which file". */
  SymbolLocate: "SYMBOL_LOCATE",
  /** A search for a code pattern. The answer wanted is "every site". */
  PatternEnumerate: "PATTERN_ENUMERATE",
  /** Glob / path discovery. The answer wanted is "which files exist". */
  PathDiscover: "PATH_DISCOVER",
  /** Read with neither offset nor limit: the whole file was asked for. */
  WholeFileRead: "WHOLE_FILE_READ",
  /** Read the agent itself bounded. The agent already knows where it is. */
  RegionRead: "REGION_READ",
  /** Repository inspection routed through the shell. */
  ShellInspect: "SHELL_INSPECT",
  /** Editing, running, installing: doing the work rather than locating it. */
  NotInvestigation: "NOT_INVESTIGATION",
});
export type OperationIntent = (typeof OperationIntent)[keyof typeof OperationIntent];

export const INVESTIGATION_INTENTS: readonly OperationIntent[] = Object.freeze([
  OperationIntent.SymbolLocate,
  OperationIntent.PatternEnumerate,
  OperationIntent.PathDiscover,
  OperationIntent.WholeFileRead,
  OperationIntent.RegionRead,
  OperationIntent.ShellInspect,
]);

/**
 * A search pattern that names one definition. Deliberately narrow: `class Foo`,
 * `def bar`, or a bare identifier. Anything with alternation, character
 * classes, or regex quantifiers is asking for a SET of sites and is an
 * enumeration, whatever it happens to return on the day.
 *
 * The distinction matters because it decides the safety class. Narrowing an
 * enumeration silently is a lie about coverage; narrowing a locate is not, but
 * a locate is also already cheap, which is most of M170's answer.
 */
const DEFINITION_PATTERN = /^\s*(class|def|function|interface|type|struct)\s+[A-Za-z_][A-Za-z0-9_]*\s*$/;
const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{2,}$/;
const REGEX_METACHARACTERS = /[|\[\](){}*+?^$\\]/;

export function isEnumerativePattern(pattern: string): boolean {
  if (DEFINITION_PATTERN.test(pattern)) return false;
  if (BARE_IDENTIFIER.test(pattern)) return false;
  return REGEX_METACHARACTERS.test(pattern) || pattern.includes(" ");
}

export interface OperationInput {
  readonly [key: string]: unknown;
}

export function classifyIntent(toolName: string, input: OperationInput): OperationIntent {
  if (toolName === "Glob") return OperationIntent.PathDiscover;
  if (toolName === "Grep") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    return isEnumerativePattern(pattern) ? OperationIntent.PatternEnumerate : OperationIntent.SymbolLocate;
  }
  if (toolName === "Read" || toolName === "NotebookRead") {
    const bounded = input.offset !== undefined || input.limit !== undefined;
    return bounded ? OperationIntent.RegionRead : OperationIntent.WholeFileRead;
  }
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return SHELL_INSPECTION.test(command) && !SHELL_NOT_INSPECTION.test(command)
      ? OperationIntent.ShellInspect
      : OperationIntent.NotInvestigation;
  }
  return OperationIntent.NotInvestigation;
}

// Kept deliberately compatible with m169Economics.classifyAction's inspection
// rule, so that M170 and M169 cannot disagree about what counts as looking.
const SHELL_INSPECTION = /(^|[\s;&|(])(grep|rg|ag|ack|find|ls|cat|head|tail|wc|tree|nl|stat|file)\b|(^|[\s;&|(])sed\s+-n\b|(^|[\s;&|(])git\s+(grep|log|blame|show|diff|status|ls-files)\b/;
const SHELL_NOT_INSPECTION = /\b(pip[0-9]*|uv|conda|poetry)\s+(install|add|sync)\b|python[0-9.]*\s+-m\s+pip\s+install|(^|[\s;&|(])(pytest|tox|nosetests)\b/;

// ── the operation record ────────────────────────────────────────────

export const Phase = Object.freeze({
  PreFirstEdit: "PRE_FIRST_EDIT",
  PostFirstEdit: "POST_FIRST_EDIT",
});
export type Phase = (typeof Phase)[keyof typeof Phase];

export interface OperationRecord {
  readonly orderIndex: number;
  readonly requestIndex: number;
  readonly toolUseId: string;
  readonly tool: string;
  readonly input: OperationInput;
  readonly intent: OperationIntent;
  readonly phase: Phase;
  /** Model-visible characters of the tool result, banner included. */
  readonly resultCharacters: number;
  /** Characters of the harness's own `<system-reminder>` banner, if any. */
  readonly bannerCharacters: number;
  readonly isError: boolean;
  /** True when the harness itself said this view is partial. */
  readonly nativePartialView: boolean;
  /** Paths named by the result, when the result names paths. */
  readonly resultPaths: readonly string[];
}

/** The harness's own partial-view banner. Its presence is a truthfulness fact. */
export const NATIVE_PARTIAL_VIEW_MARKER = "[Truncated: PARTIAL view";

const READ_LINE = /^\s*(\d+)\t/;

function bannerLength(text: string): number {
  const start = text.indexOf("<system-reminder>");
  if (start < 0) return 0;
  const end = text.indexOf("</system-reminder>", start);
  return end < 0 ? text.length - start : end + "</system-reminder>".length - start;
}

/**
 * Paths a result names, for the two result shapes that name them: Grep in
 * `files_with_matches` mode ("Found N files\n<path>\n…") and Glob (one path
 * per line). Content-mode Grep prefixes each line with `path:line:`.
 */
export function pathsNamedByResult(tool: string, text: string): readonly string[] {
  if (tool !== "Grep" && tool !== "Glob") return Object.freeze([]);
  const paths = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("Found ") || line.startsWith("No ")) continue;
    if (line.startsWith("[Showing results")) continue;
    const colon = line.match(/^([^\s:]+\.[A-Za-z0-9_]+):\d+[:-]/);
    if (colon !== null) { paths.add(colon[1]!); continue; }
    const dash = line.match(/^([^\s:]+\.[A-Za-z0-9_]+)-\d+-/);
    if (dash !== null) { paths.add(dash[1]!); continue; }
    if (/^[^\s]+\.[A-Za-z0-9_]+$/.test(line)) paths.add(line);
  }
  return Object.freeze([...paths]);
}

/** Line span a `cat -n` Read result actually covers, or null if not one. */
export function readSpanOf(text: string): { readonly first: number; readonly last: number } | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const line of text.split("\n")) {
    const match = READ_LINE.exec(line);
    if (match === null) continue;
    const number = Number(match[1]);
    if (first === null) first = number;
    last = number;
  }
  return first === null || last === null ? null : { first, last };
}

interface RawContentBlock {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
  readonly tool_use_id?: unknown;
  readonly content?: unknown;
  readonly is_error?: unknown;
}

function resultText(block: RawContentBlock): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text
      : ""))
    .join("");
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Reconstruct the ordered operation trace from a Claude Code stream-json
 * transcript. Pairing is by `tool_use_id`; a tool_use with no result (the run
 * was killed mid-turn) is dropped and counted by the caller as unpaired.
 */
export function parseOperations(lines: readonly string[]): readonly OperationRecord[] {
  interface Pending {
    readonly requestIndex: number;
    readonly tool: string;
    readonly input: OperationInput;
  }
  const pending = new Map<string, Pending>();
  const results: { id: string; text: string; isError: boolean }[] = [];
  const seenRequestIds = new Set<string>();
  let requestIndex = -1;

  for (const line of lines) {
    if (line.trim() === "") continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const message = row.message as Record<string, unknown> | undefined;
    const blocks = (Array.isArray(message?.content) ? message!.content : []) as RawContentBlock[];

    if (row.type === "assistant") {
      const id = typeof message?.id === "string" ? message.id : null;
      if (id === null) continue;
      if (!seenRequestIds.has(id)) { seenRequestIds.add(id); requestIndex += 1; }
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        const useId = typeof block.id === "string" ? block.id : null;
        if (useId === null) continue;
        pending.set(useId, {
          requestIndex,
          tool: typeof block.name === "string" ? block.name : "unknown",
          input: (block.input ?? {}) as OperationInput,
        });
      }
      continue;
    }

    if (row.type === "user") {
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const useId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
        if (useId === null) continue;
        results.push({ id: useId, text: resultText(block), isError: block.is_error === true });
      }
    }
  }

  // The first edit splits investigation from work. It is located over the same
  // ordered result list, so a run that never edits is entirely PRE_FIRST_EDIT.
  let firstEditOrder = Number.POSITIVE_INFINITY;
  results.forEach((entry, order) => {
    const use = pending.get(entry.id);
    if (use !== undefined && EDIT_TOOLS.has(use.tool) && order < firstEditOrder) firstEditOrder = order;
  });

  const records: OperationRecord[] = [];
  results.forEach((entry, order) => {
    const use = pending.get(entry.id);
    if (use === undefined) return;
    const banner = bannerLength(entry.text);
    records.push({
      orderIndex: order,
      requestIndex: use.requestIndex,
      toolUseId: entry.id,
      tool: use.tool,
      input: use.input,
      intent: classifyIntent(use.tool, use.input),
      phase: order < firstEditOrder ? Phase.PreFirstEdit : Phase.PostFirstEdit,
      resultCharacters: entry.text.length,
      bannerCharacters: banner,
      isError: entry.isError,
      nativePartialView: entry.text.includes(NATIVE_PARTIAL_VIEW_MARKER),
      resultPaths: pathsNamedByResult(use.tool, entry.text),
    });
  });
  return Object.freeze(records);
}

export function isInvestigationIntent(intent: OperationIntent): boolean {
  return INVESTIGATION_INTENTS.includes(intent);
}

// ── candidate mediation families and their semantics ────────────────

export const SafetyClass = Object.freeze({
  SafeNarrowing: "SAFE_NARROWING",
  SafeRanking: "SAFE_RANKING",
  SafeAugmentation: "SAFE_AUGMENTATION",
  Unsafe: "SEMANTICALLY_UNSAFE_REPLACEMENT",
});
export type SafetyClass = (typeof SafetyClass)[keyof typeof SafetyClass];

export const MediationFamily = Object.freeze({
  RankedSearch: "A_RANKED_SEARCH_MEDIATION",
  SymbolAwareRead: "B_SYMBOL_AWARE_READ",
  SearchToGraph: "C_SEARCH_TO_GRAPH_EXPANSION",
  None: "D_NO_VIABLE_MEDIATION",
});
export type MediationFamily = (typeof MediationFamily)[keyof typeof MediationFamily];

/**
 * What the native tool says about its own bounds, per harness surface.
 *
 * This table is the reason M170 can classify safety at all, and it is read
 * from the shipped Claude Code binary rather than from documentation:
 *
 *   Grep   `mapToolResultToToolResultBlockParam` appends
 *          "[Showing results with pagination = …]" whenever a limit or offset
 *          was applied, and `count` mode reports "Found N total occurrences
 *          across M files". A bound is therefore SELF-DECLARING on Grep.
 *
 *   Glob   reports "Found N files" and a `truncated` / `totalMatches` pair in
 *          its structured output; the text surface declares pagination the
 *          same way Grep does.
 *
 *   Read   auto-paginates and emits "[Truncated: PARTIAL view — …]" ONLY when
 *          the read was a whole-file read that exceeded the token cap. The
 *          guard is `(offset ?? 1) <= 1 && limit === undefined`. Supplying a
 *          limit takes the read OFF that path: no banner is emitted, and
 *          `truncatedByTokenCap` is not set. A bound is therefore NOT
 *          self-declaring on Read.
 *
 * The asymmetry decides M170. Bounding a Grep leaves the bound legible in the
 * tool's own words; bounding a Read removes the only sentence that would have
 * told the agent its view was partial.
 */
export const NATIVE_BOUND_DISCLOSURE = Object.freeze({
  harness: "claude-code",
  harnessVersion: "2.1.240",
  Grep: Object.freeze({
    selfDeclaring: true,
    mechanism: "[Showing results with pagination = limit: N] appended by the tool's own result mapper",
    totalsAvailable: true,
  }),
  Glob: Object.freeze({
    selfDeclaring: true,
    mechanism: "Found N files + pagination suffix; structured output carries truncated/totalMatches",
    totalsAvailable: true,
  }),
  Read: Object.freeze({
    selfDeclaring: false,
    mechanism: "[Truncated: PARTIAL view — …] is emitted ONLY for whole-file reads over the token cap; "
      + "supplying offset/limit suppresses both the banner and truncatedByTokenCap",
    totalsAvailable: false,
  }),
});

export interface FamilyVerdict {
  readonly family: MediationFamily;
  readonly appliesTo: readonly OperationIntent[];
  readonly seam: string;
  readonly safety: SafetyClass;
  readonly rationale: string;
}

/**
 * The candidate designs, classified before they are measured (§10).
 *
 * A design is disqualified here only on SEMANTICS. Being safe does not make a
 * design economic, and M170-C decides that separately.
 */
export const FAMILY_VERDICTS: readonly FamilyVerdict[] = Object.freeze([
  Object.freeze({
    family: MediationFamily.RankedSearch,
    appliesTo: Object.freeze([OperationIntent.PatternEnumerate, OperationIntent.SymbolLocate, OperationIntent.PathDiscover]),
    seam: "PreToolUse updatedInput: head_limit on the agent's own Grep/Glob",
    safety: SafetyClass.SafeNarrowing,
    rationale: "the bound is applied through the tool's own pagination parameter, and the tool states it: "
      + "'[Showing results with pagination = limit: N]'. Omission stays legible and the omitted matches "
      + "remain reachable by re-issuing without the bound. VTRACE cannot reorder rg's output through this "
      + "seam, so this family narrows; it does not rank.",
  }),
  Object.freeze({
    family: MediationFamily.SymbolAwareRead,
    appliesTo: Object.freeze([OperationIntent.WholeFileRead]),
    seam: "PreToolUse updatedInput: offset/limit on the agent's own Read",
    safety: SafetyClass.Unsafe,
    rationale: "supplying offset/limit takes the read off the harness's auto-pagination path, which is the "
      + "only thing that would have said the view is partial. The agent asked a whole-file question and "
      + "would receive a page that does not say it is a page — bounded omission presented as absence. "
      + "Restorable to SAFE_NARROWING only by re-adding a disclosure, which costs model tokens the "
      + "narrowing must then pay for.",
  }),
  Object.freeze({
    family: MediationFamily.SearchToGraph,
    appliesTo: Object.freeze([OperationIntent.SymbolLocate]),
    seam: "PostToolUse additionalContext: graph evidence appended to a search result",
    safety: SafetyClass.SafeAugmentation,
    rationale: "strictly adds material to a result the agent already paid for. Disqualified on arrival by "
      + "§13 unless it displaces more traffic than it adds, which is a Level 2 claim and not decidable offline.",
  }),
]);
