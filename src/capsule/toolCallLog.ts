// Ordered tool-call log for pivot inspection (telemetry only).
//
// Claude Code emits stream-json: one JSON event per line. Assistant messages
// carry `content` blocks including `tool_use` (name + input); `tool_result`
// events carry the output of the preceding call. The external vexp-swe-bench
// adapter collapses these into AGGREGATE counts (`{Read: 2, Edit: 2}`), losing
// ordering and targets — which is why pivot inspection could not tell a direct
// read of a pivot from a grep that merely surfaced it.
//
// This module recovers the ORDERED list (with file targets and search results)
// from the captured stream-json, so `classifyPivotInspection` can distinguish
// `inspected` (read the file) from `discovered` (saw it in search). It changes
// no retrieval, scoring, candidate generation, prompt, or patch behavior, and
// reads no gold labels.

import type { InspectionToolCall } from "./finalEditDiagnostics";

export type ToolCategory = "read" | "search" | "edit" | "other";

// One agent tool call, in order. `args` is the sanitized raw input; `path` and
// `query` are the conventional fields pulled out for convenience.
export interface OrderedToolCall {
  index: number;
  tool: string;
  category: ToolCategory;
  path: string | null;
  query: string | null;
  args: Record<string, unknown>;
  output_summary: string | null;
}

// Tool-name → internal category. Normalizes the differing names the external
// adapter / Claude Code may emit (Read vs view vs open, Grep vs ripgrep, …).
const READ_TOOLS = new Set(["read", "view", "open", "cat", "readfile", "read_file", "notebookread"]);
const SEARCH_TOOLS = new Set([
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
const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "str_replace",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "multiedit",
  "notebookedit",
  "apply_patch",
]);

export function toolCategory(tool: string): ToolCategory {
  const normalized = tool.toLowerCase().trim();
  if (READ_TOOLS.has(normalized)) return "read";
  if (SEARCH_TOOLS.has(normalized)) return "search";
  if (EDIT_TOOLS.has(normalized)) return "edit";
  return "other";
}

const PATH_KEYS = ["file_path", "filePath", "path", "file", "filename", "notebook_path"];
const QUERY_KEYS = ["pattern", "query", "regex", "search"];
// Cap captured tool output so a Read of a large file (or a long grep dump) does
// not bloat the persisted log; the head is enough to detect a path/symbol match.
const OUTPUT_SUMMARY_MAX = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function summarize(content: unknown): string {
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  return text.length > OUTPUT_SUMMARY_MAX ? text.slice(0, OUTPUT_SUMMARY_MAX) : text;
}

function pushToolUse(calls: OrderedToolCall[], block: Record<string, unknown>): void {
  const name = typeof block.name === "string" ? block.name : "unknown";
  const args = isRecord(block.input) ? block.input : {};
  calls.push({
    index: calls.length,
    tool: name,
    category: toolCategory(name),
    path: firstString(args, PATH_KEYS),
    query: firstString(args, QUERY_KEYS),
    args,
    output_summary: null,
  });
}

// Parse the captured stream-json into an ordered tool-call list. Tolerant: skips
// non-JSON / unexpected lines, so a noisy or partial capture still yields what it
// can rather than throwing.
export function parseOrderedToolCalls(streamJson: string): OrderedToolCall[] {
  const calls: OrderedToolCall[] = [];
  for (const line of streamJson.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;

    if (event.type === "assistant") {
      const message = isRecord(event.message) ? event.message : null;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isRecord(block) && block.type === "tool_use") pushToolUse(calls, block);
        }
      }
    } else if (event.type === "tool_use") {
      pushToolUse(calls, event);
    } else if (event.type === "tool_result") {
      // Attach the result to the most recent call still awaiting one.
      const last = calls[calls.length - 1];
      if (last && last.output_summary === null) last.output_summary = summarize(event.content);
    }
  }
  return calls;
}

// Map ordered calls into the classifier's `InspectionToolCall` shape. `output`
// carries the search result (or the query as a fallback) so a grep that surfaces
// a pivot path/symbol is detected as `discovered` rather than `inspected`.
export function toInspectionToolCalls(ordered: readonly OrderedToolCall[]): InspectionToolCall[] {
  return ordered.map((call) => ({
    tool: call.tool,
    target: call.path,
    output: call.output_summary ?? call.query,
  }));
}

// Coerce a loaded `_tool_calls.json` value into `InspectionToolCall[]`, or null
// when the artifact is absent / not an array (so the caller keeps the honest
// false-by-absence behavior). Lenient on field names for forward compatibility.
export function inspectionCallsFromLog(value: unknown): InspectionToolCall[] | null {
  if (!Array.isArray(value)) return null;
  const calls: InspectionToolCall[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const tool = typeof entry.tool === "string" ? entry.tool : null;
    if (tool === null) continue;
    const path = typeof entry.path === "string" ? entry.path : null;
    const query = typeof entry.query === "string" ? entry.query : null;
    const outputSummary = typeof entry.output_summary === "string" ? entry.output_summary : null;
    calls.push({ tool, target: path, output: outputSummary ?? query });
  }
  return calls;
}
