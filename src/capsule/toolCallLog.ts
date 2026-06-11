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

// Shell/command tools. These fall under category "other" (they are neither a
// file read/search/edit), so the loop heuristics count them separately: a long
// run of Bash calls is the "long bash loop" symptom the Stage 5 audit watches.
const BASH_TOOLS = new Set([
  "bash",
  "shell",
  "sh",
  "run_command",
  "run_terminal_cmd",
  "execute_command",
  "terminal",
  "command",
]);

export function isBashTool(tool: string): boolean {
  return BASH_TOOLS.has(tool.toLowerCase().trim());
}

// Diagnostic summary of one run's ordered tool calls. Telemetry only — these
// counts and heuristics never affect retrieval, ranking, prompt, or patch
// generation. `orderedTelemetryAvailable` is false when there was no parsed
// ordered log to summarize (legacy run / missing stream-json), in which case
// every count is 0 and both loop heuristics are false.
export interface OrderedToolCallSummary {
  totalToolCalls: number;
  bashToolCalls: number;
  grepLikeToolCalls: number;
  fileReadToolCalls: number;
  fileWriteToolCalls: number;
  uniqueFilesTouchedByTools: number;
  longBashLoopHeuristic: boolean;
  repeatedSearchHeuristic: boolean;
  orderedTelemetryAvailable: boolean;
}

// Conservative loop heuristics (diagnostic only — see the interface doc).
const LONG_BASH_LOOP_THRESHOLD = 8;
const REPEATED_SEARCH_THRESHOLD = 5;

// Compute the diagnostic summary from an ordered tool-call list. When
// `orderedTelemetryAvailable` is false the caller had no parsed log, so we
// return an all-zero summary rather than fabricating counts.
export function summarizeOrderedToolCalls(
  calls: readonly OrderedToolCall[],
  orderedTelemetryAvailable = true,
): OrderedToolCallSummary {
  if (!orderedTelemetryAvailable) {
    return {
      totalToolCalls: 0,
      bashToolCalls: 0,
      grepLikeToolCalls: 0,
      fileReadToolCalls: 0,
      fileWriteToolCalls: 0,
      uniqueFilesTouchedByTools: 0,
      longBashLoopHeuristic: false,
      repeatedSearchHeuristic: false,
      orderedTelemetryAvailable: false,
    };
  }
  let bashToolCalls = 0;
  let grepLikeToolCalls = 0;
  let fileReadToolCalls = 0;
  let fileWriteToolCalls = 0;
  const files = new Set<string>();
  const searchPatterns = new Map<string, number>();
  let repeatedSamePattern = false;
  for (const call of calls) {
    if (isBashTool(call.tool)) bashToolCalls += 1;
    if (call.category === "search") {
      grepLikeToolCalls += 1;
      if (call.query !== null) {
        const next = (searchPatterns.get(call.query) ?? 0) + 1;
        searchPatterns.set(call.query, next);
        if (next >= 2) repeatedSamePattern = true;
      }
    }
    if (call.category === "read") fileReadToolCalls += 1;
    if (call.category === "edit") fileWriteToolCalls += 1;
    if (call.path !== null) files.add(call.path);
  }
  return {
    totalToolCalls: calls.length,
    bashToolCalls,
    grepLikeToolCalls,
    fileReadToolCalls,
    fileWriteToolCalls,
    uniqueFilesTouchedByTools: files.size,
    longBashLoopHeuristic: bashToolCalls >= LONG_BASH_LOOP_THRESHOLD,
    repeatedSearchHeuristic: grepLikeToolCalls >= REPEATED_SEARCH_THRESHOLD || repeatedSamePattern,
    orderedTelemetryAvailable: true,
  };
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

// Concatenate the agent's ASSISTANT-side text from the captured stream-json. Only
// `assistant` events contribute (their `text` content blocks): the injected
// context — which itself contains "PIVOT_CHECK" — rides in the user/prompt
// message, so scanning the whole stream would always match. Scoping to assistant
// text keeps "did the agent emit a checklist?" an honest agent-output signal.
export function assistantTextFromStream(streamJson: string): string {
  const parts: string[] = [];
  for (const line of streamJson.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(event) || event.type !== "assistant") continue;
    const message = isRecord(event.message) ? event.message : null;
    const content = message?.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
    }
  }
  return parts.join("\n");
}

// The marker a PIVOT_CHECK enforcement block (and the agent's echo of it) carries.
export const PIVOT_CHECK_MARKER = "PIVOT_CHECK";

// Minimal detector: did the agent's response include a PIVOT_CHECK section? Scans
// assistant text only (see `assistantTextFromStream`). This is a presence detector,
// not a row parser — full row-level parsing of the checklist table (claimed
// inspected=yes vs. tool evidence) is deliberately deferred. TODO: parse the
// emitted table rows so `checklistVsToolsAgreement` can compare per-row claims.
export function detectPivotChecklistEmitted(streamJson: string): boolean {
  return assistantTextFromStream(streamJson).includes(PIVOT_CHECK_MARKER);
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
