// Final-edit diagnostics.
//
// Outcome-side signals for the Stage 5 benchmark: parse the model's unified diff
// for the file and symbol it actually edited, and check whether the context that
// vtrace injected even mentioned them. This is how a run tells "tiny context"
// apart from "tiny AND misdirecting context" — the latter forces the agent to
// explore, which shows up as extra tokens.
//
// Everything here is general diff parsing. The final edited file/symbol come from
// the patch, never from a per-instance lookup table.

import { stripDiffPrefix } from "./sweQueryShaping";

// Files the patch writes, from `+++ b/<path>` headers. Deletions (`/dev/null`)
// are skipped and the `a/`/`b/` diff prefix is normalised away.
export function editedFilesFromPatch(patch: string): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("+++ ")) continue;
    // A trailing tab + timestamp is legal in unified diffs; keep only the path.
    const raw = line.slice(4).split("\t")[0]?.trim() ?? "";
    if (raw.length === 0 || raw === "/dev/null") continue;
    const file = stripDiffPrefix(raw);
    if (!seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

// Tool names that MUTATE the workspace (file edits + shell). Used to enforce a
// read-only preflight: any of these appearing in Phase-1 telemetry is a gate
// violation. Bash is treated as unsafe-by-default — a read-only preflight cannot
// cheaply prove a shell command is non-mutating, so its mere use fails the gate.
// Names are matched case-insensitively against the agent's tool-call stream.
export const MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "edit",
  "multiedit",
  "write",
  "notebookedit",
  "applypatch",
  "apply_patch",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "bash",
]);

// The mutation/unsafe tool names that appear in a tool-call stream, de-duplicated
// and sorted, preserving the ORIGINAL casing of the first occurrence so the report
// shows what the agent actually invoked. Pure.
export function mutationToolCallsIn(toolCalls: readonly InspectionToolCall[]): string[] {
  const seen = new Map<string, string>();
  for (const call of toolCalls) {
    const norm = call.tool.toLowerCase().trim();
    if (MUTATION_TOOL_NAMES.has(norm) && !seen.has(norm)) seen.set(norm, call.tool);
  }
  return [...seen.values()].sort();
}

// The "final edited file" is the primary edit target: prefer the first non-test
// source file, falling back to the first file when a patch only touches tests.
export function primaryEditedFile(patch: string): string | null {
  const files = editedFilesFromPatch(patch);
  if (files.length === 0) return null;
  return files.find((file) => !looksLikeTestPath(file)) ?? files[0] ?? null;
}

function looksLikeTestPath(file: string): boolean {
  const base = file.split("/").pop() ?? file;
  return /(^|\/)tests?\//.test(file) || base.startsWith("test_") || /_tests?\.\w+$/.test(base);
}

const ADDED_DEF = /^\+\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/;
const HUNK_DEF = /^@@.*@@\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/;

// Symbols the patch touches: definitions it adds (`+def foo` / `+class Bar`)
// first, then the enclosing symbols named in hunk headers.
export function editedSymbolsFromPatch(patch: string): string[] {
  const added: string[] = [];
  const enclosing: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const addedMatch = ADDED_DEF.exec(line);
    if (addedMatch?.[1]) {
      added.push(addedMatch[1]);
      continue;
    }
    const hunkMatch = HUNK_DEF.exec(line);
    if (hunkMatch?.[1]) enclosing.push(hunkMatch[1]);
  }
  return dedupe([...added, ...enclosing]);
}

export function primaryEditedSymbol(patch: string): string | null {
  return editedSymbolsFromPatch(patch)[0] ?? null;
}

// Does the injected context mention this file? Accept the full repo-relative path
// or its basename (a capsule may show only the leaf), so the check is lenient on
// form but honest about presence.
export function contextMentionsFile(context: string, file: string): boolean {
  if (context.length === 0 || file.length === 0) return false;
  if (context.includes(file)) return true;
  const base = file.split("/").pop() ?? "";
  return base.length > 0 && context.includes(base);
}

export function contextMentionsSymbol(context: string, symbol: string): boolean {
  if (context.length === 0 || symbol.length === 0) return false;
  return new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(context);
}

// ----- final-edited-file role (Stage 5 post-hoc) ------------------------------
//
// Containment was previously a yes/no: did the injected context mention the file
// the model ended up editing? That is too coarse — context that surfaced the
// edit target as a PIVOT (full source, top of the capsule) is a far stronger
// result than one that buried it as a skeleton-only SUPPORT item. These helpers
// upgrade the post-hoc signal to which ROLE the final edited file held, so the
// benchmark can reward "we pivoted on the right file", not merely "we mentioned
// it somewhere". Kept role-shape-only so there is no capsule import cycle.

export type FinalEditedFileRole = "pivot" | "support" | "missing";

export interface RoledSelectionEntry {
  role: "pivot" | "support";
  path: string;
}

export interface FinalEditedFileContainment {
  final_edited_file: string | null;
  contains_final_edited_file: boolean;
  final_edited_file_role: FinalEditedFileRole;
}

// The role under which `finalEditedFile` appeared in the selection, or "missing"
// if it was never selected. A file selected as BOTH (a pivot symbol and a support
// symbol from the same file) reports "pivot" — the stronger role wins.
export function finalEditedFileRole(
  selection: readonly RoledSelectionEntry[],
  finalEditedFile: string | null,
): FinalEditedFileRole {
  if (finalEditedFile === null || finalEditedFile.length === 0) {
    return "missing";
  }
  let sawSupport = false;
  for (const entry of selection) {
    if (!samePath(entry.path, finalEditedFile)) {
      continue;
    }
    if (entry.role === "pivot") {
      return "pivot";
    }
    sawSupport = true;
  }
  return sawSupport ? "support" : "missing";
}

// Build the Stage 5 post-hoc containment object from a roled selection.
export function buildFinalEditedFileContainment(
  selection: readonly RoledSelectionEntry[],
  finalEditedFile: string | null,
): FinalEditedFileContainment {
  const role = finalEditedFileRole(selection, finalEditedFile);
  return {
    final_edited_file: finalEditedFile,
    contains_final_edited_file: role !== "missing",
    final_edited_file_role: role,
  };
}

// Lenient path match: exact, one a path-suffix of the other, or equal basenames
// (a selection may carry only the repo-relative path or just the leaf).
function samePath(selectionPath: string, editedFile: string): boolean {
  if (selectionPath === editedFile) return true;
  if (selectionPath.endsWith(`/${editedFile}`) || editedFile.endsWith(`/${selectionPath}`)) {
    return true;
  }
  const a = selectionPath.split("/").pop() ?? selectionPath;
  const b = editedFile.split("/").pop() ?? editedFile;
  return a.length > 0 && a === b;
}

// ----- pivot inspection (Stage 5 post-hoc, pivot-inspection loop) -------------
//
// Did the agent actually ENGAGE with each Capsule v2 pivot before patching, or
// did it edit the traceback-named file and silently skip the hidden pivot that
// held the root cause (the sphinx-7462 gap)? This classifies, per surfaced
// pivot, what the agent did with it — using only agent-side artifacts (the
// ordered tool-call log and the final patch), never the gold patch or any
// expected-label table. See docs/benchmarks/capsule_v2_pivot_inspection_loop_spec.md.
//
// The load-bearing rule: a grep/search that merely SURFACES a path or symbol is
// `discovered`, NOT `inspected`. Inspection means the agent directly opened/read
// the pivot file's contents. Search reveals a file exists; inspection means the
// agent actually looked inside it. This is why `discovered` never, on its own,
// promotes the status above `ignored` — visibility is not engagement.

// Read/open operations: the agent looked at a file's CONTENTS.
const PIVOT_READ_TOOLS = new Set([
  "read",
  "view",
  "open",
  "cat",
  "readfile",
  "read_file",
  "str_replace_editor", // view-mode opens count; edits are detected from the patch
]);

// Search/grep operations: the agent learned a path/symbol EXISTS, but did not
// necessarily read it. These never count as inspection.
const PIVOT_SEARCH_TOOLS = new Set([
  "grep",
  "grep_search",
  "glob",
  "search",
  "find",
  "ripgrep",
  "rg",
  "codebase_search",
  "ls",
]);

// The terminal classification for one pivot. `discovered` is an observation flag,
// not a terminal status: a pivot seen only in search output is still `ignored`
// (the agent never engaged with its contents).
export type PivotInspectionStatus =
  | "edited"
  | "edited_without_inspection"
  | "ruled_out"
  | "inspected"
  | "ignored";

// A Capsule v2 pivot to classify. Shape-only — carries no scoring or gold data.
export interface PivotForInspection {
  readonly path: string;
  readonly symbol: string;
  readonly role: "pivot" | "support";
  // Non-source-anchored pivot (surfaced by symbol/graph/literal reasoning rather
  // than a traceback/issue line) — the kind a traceback-following agent skips.
  readonly hidden: boolean;
}

// One ordered tool call from the agent's run. `target` is the file-path argument
// (when the tool takes one); `output` is the textual result (e.g. grep matches),
// used only to detect search-time DISCOVERY of a pivot.
export interface InspectionToolCall {
  readonly tool: string;
  readonly target?: string | null;
  readonly output?: string | null;
}

// A pivot the agent EXPLICITLY ruled out (e.g. a checklist row marked not
// edit-needed with a grounded reason). Parsed upstream from the agent's emitted
// pivot-inspection checklist; never inferred from gold.
export interface PivotRuleOut {
  readonly path: string;
}

export interface PivotInspectionRecord {
  readonly path: string;
  readonly symbol: string;
  readonly role: "pivot" | "support";
  readonly hidden: boolean;
  readonly discovered: boolean;
  readonly inspected: boolean;
  readonly edited: boolean;
  readonly edited_without_inspection: boolean;
  readonly ruled_out: boolean;
  readonly status: PivotInspectionStatus;
}

// Does a search call's textual output surface this pivot's path or symbol?
function searchOutputMentions(output: string | null | undefined, path: string, symbol: string): boolean {
  if (typeof output !== "string" || output.length === 0) return false;
  if (path.length > 0 && output.includes(path)) return true;
  const base = path.split("/").pop() ?? "";
  if (base.length > 0 && output.includes(base)) return true;
  if (symbol.length > 0 && new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(output)) return true;
  return false;
}

// Classify what the agent did with each Capsule v2 pivot. Pure: depends only on
// the pivot list, the agent's ordered tool calls, the files its patch touched,
// and any explicit rule-out claims. No gold patch, no expected-label lookup —
// a pivot that happens to be the correct fix but was never read/edited is
// `ignored` like any other, so the classifier cannot leak gold labels.
export function classifyPivotInspection(
  pivots: readonly PivotForInspection[],
  toolCalls: readonly InspectionToolCall[],
  editedFiles: readonly string[],
  ruledOut: readonly PivotRuleOut[] = [],
): PivotInspectionRecord[] {
  const normalize = (tool: string): string => tool.toLowerCase().trim();
  const reads = toolCalls.filter((call) => PIVOT_READ_TOOLS.has(normalize(call.tool)));
  const searches = toolCalls.filter((call) => PIVOT_SEARCH_TOOLS.has(normalize(call.tool)));

  return pivots.map((pivot) => {
    // Inspection: a direct read/open whose target is the pivot path. A search
    // listing the path does NOT count, by design.
    const inspected = reads.some(
      (call) => typeof call.target === "string" && samePath(call.target, pivot.path),
    );
    // Editing is taken from the final patch (authoritative end state), never from
    // a tool-call name.
    const edited = editedFiles.some((file) => samePath(file, pivot.path));
    const editedWithoutInspection = edited && !inspected;
    // Discovery: the pivot showed up in a search (as the search target or in its
    // output) but the file was never opened/read.
    const seenInSearch = searches.some(
      (call) =>
        (typeof call.target === "string" && samePath(call.target, pivot.path)) ||
        searchOutputMentions(call.output, pivot.path, pivot.symbol),
    );
    const discovered = !inspected && seenInSearch;
    // Ruling out is only meaningful AFTER inspection — an agent cannot grounded-ly
    // dismiss a pivot it never opened.
    const ruled_out = inspected && ruledOut.some((entry) => samePath(entry.path, pivot.path));

    const status: PivotInspectionStatus = editedWithoutInspection
      ? "edited_without_inspection"
      : edited
        ? "edited"
        : ruled_out
          ? "ruled_out"
          : inspected
            ? "inspected"
            : "ignored";

    return {
      path: pivot.path,
      symbol: pivot.symbol,
      role: pivot.role,
      hidden: pivot.hidden,
      discovered,
      inspected,
      edited,
      edited_without_inspection: editedWithoutInspection,
      ruled_out,
      status,
    };
  });
}

// ----- PIVOT_CHECK row parsing + checklist-vs-tool agreement -------------------
//
// The injected PIVOT_CHECK block asks the agent to fill a table:
//   | pivot | symbol | inspected | relevant | edit_needed | reason |
// These helpers parse the agent's FILLED rows from its assistant text, then check
// each claimed `inspected` against tool-derived inspection (classifyPivotInspection)
// — catching the failure mode where the agent claims to have inspected a pivot it
// never opened. Pure: no gold patch, no I/O.

// One parsed checklist row the agent emitted. `inspected`/`editNeeded` are null
// when the cell was left as the `yes/no` template or was otherwise unparseable.
export interface PivotCheckRow {
  readonly path: string;
  readonly inspected: boolean | null;
  readonly editNeeded: boolean | null;
  readonly reason: string;
}

// Parse a yes/no-ish cell. The injected template literal `yes/no` (unfilled) and
// anything ambiguous return null so an unfilled row never counts as a claim.
function parseYesNoCell(cell: string): boolean | null {
  const value = cell.trim().toLowerCase();
  if (value === "yes" || value === "y" || value === "true" || value === "✓") return true;
  if (value === "no" || value === "n" || value === "false") return false;
  return null;
}

// Extract the agent's filled PIVOT_CHECK rows from its assistant text. Scans for
// Markdown table rows with at least the 6 checklist columns; the header
// (`| pivot | symbol | ...`) and separator (`|---|`) rows and the unfilled
// `yes/no` template rows are skipped. Tolerant of extra whitespace.
export function parsePivotCheckRows(assistantText: string): PivotCheckRow[] {
  const rows: PivotCheckRow[] = [];
  for (const rawLine of assistantText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    // Split interior cells (drop the leading/trailing empty splits from the pipes).
    const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells.length < 6) continue;
    const [path, , inspectedCell, , editNeededCell, ...reasonParts] = cells;
    if (path === undefined || path.length === 0) continue;
    // Skip the header row and the separator row.
    if (path.toLowerCase() === "pivot") continue;
    if (/^:?-{2,}:?$/.test(path)) continue;
    const inspected = parseYesNoCell(inspectedCell ?? "");
    const editNeeded = parseYesNoCell(editNeededCell ?? "");
    // An entirely-template row (both cells still `yes/no`) is not a real claim.
    if (inspected === null && editNeeded === null && (inspectedCell ?? "").includes("/")) continue;
    rows.push({
      path,
      inspected,
      editNeeded,
      reason: reasonParts.join("|").trim(),
    });
  }
  return rows;
}

// Agreement between the agent's CLAIMED inspection and the tool-derived truth.
// `agreement` is the fraction of matched rows whose claimed `inspected` equals the
// classifier's `inspected` (the load-bearing honesty check). `null` when no row
// could be matched to a pivot record or carried a parseable inspected-claim.
export interface ChecklistToolAgreement {
  readonly rowsParsed: number;
  readonly rowsMatched: number;
  readonly inspectedClaims: number;
  readonly inspectedAgreements: number;
  // Rows where the agent claimed inspected=yes but tools show it never opened the
  // pivot — the dishonest-claim count the gate most wants to surface.
  readonly claimedInspectedButNot: number;
  readonly agreement: number | null;
}

export function checklistToolAgreement(
  rows: readonly PivotCheckRow[],
  records: readonly PivotInspectionRecord[],
): ChecklistToolAgreement {
  let rowsMatched = 0;
  let inspectedClaims = 0;
  let inspectedAgreements = 0;
  let claimedInspectedButNot = 0;

  for (const row of rows) {
    const record = records.find((entry) => samePath(entry.path, row.path));
    if (record === undefined) continue;
    rowsMatched += 1;
    if (row.inspected === null) continue;
    inspectedClaims += 1;
    if (row.inspected === record.inspected) {
      inspectedAgreements += 1;
    } else if (row.inspected && !record.inspected) {
      claimedInspectedButNot += 1;
    }
  }

  return {
    rowsParsed: rows.length,
    rowsMatched,
    inspectedClaims,
    inspectedAgreements,
    claimedInspectedButNot,
    agreement: inspectedClaims > 0 ? inspectedAgreements / inspectedClaims : null,
  };
}

// The agent's `neighborhood_use` accounting (which provided neighborhood excerpts
// it used, and which it ruled out). Parsed from the agent's response so the gate
// can require the agent to have addressed the neighborhood, not just the pivots.
export interface NeighborhoodUse {
  // The agent emitted a `neighborhood_use` accounting at all.
  readonly present: boolean;
  // Excerpt identifiers (paths/symbols) the agent said it used.
  readonly used: readonly string[];
  // Excerpt identifiers the agent said it ruled out.
  readonly ruledOut: readonly string[];
}

// Pull comma/semicolon-separated identifier tokens after a `field:` label on one
// line, dropping `none`/`n/a` placeholders. Tolerant of surrounding prose.
function valuesAfterLabel(line: string): string[] {
  const colon = line.indexOf(":");
  const rest = (colon === -1 ? line : line.slice(colon + 1)).trim();
  if (rest.length === 0) return [];
  return rest
    .split(/[,;]/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !/^(none|n\/a|n\.a\.)$/i.test(token));
}

// Parse the agent's `neighborhood_use` block from its response text. `present` is
// true when the agent emitted a `neighborhood_use` header AND at least one
// used/ruled-out line under it. Tolerant of inline (`used: ...`) and bulleted
// (`- used: ...`) forms. Pure; assistant text in, structured accounting out.
export function parseNeighborhoodUse(text: string): NeighborhoodUse {
  const lines = text.split(/\r?\n/);
  let headerIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/neighborhood_use\b/i.test(lines[index]!)) {
      headerIndex = index;
      break;
    }
  }
  if (headerIndex === -1) return { present: false, used: [], ruledOut: [] };

  const used: string[] = [];
  const ruledOut: string[] = [];
  let sawField = false;
  // The header line itself may carry `used:`/`ruled_out:` inline; otherwise scan a
  // small window of following lines for the two sub-fields.
  for (let index = headerIndex; index < Math.min(lines.length, headerIndex + 8); index += 1) {
    const line = lines[index]!;
    const lower = line.toLowerCase();
    if (index > headerIndex && /neighborhood_use\b/i.test(line) === false && line.trim() === "") {
      // blank line ends a bulleted block only after we have seen a field
      if (sawField) break;
    }
    if (/\bused\b\s*:/.test(lower) && !/ruled/.test(lower)) {
      used.push(...valuesAfterLabel(line));
      sawField = true;
    }
    if (/ruled[_ ]?out\b\s*:/.test(lower)) {
      ruledOut.push(...valuesAfterLabel(line));
      sawField = true;
    }
  }
  return { present: sawField, used: dedupe(used), ruledOut: dedupe(ruledOut) };
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
