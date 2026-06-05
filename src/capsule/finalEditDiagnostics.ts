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
