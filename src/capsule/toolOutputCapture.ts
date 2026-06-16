// M21 — enriched tool-call + test-command capture from agent stream-json.
//
// `toolCallLog.ts` recovers the ORDERED tool calls but leaves `output_summary` null in
// real captures, because the external adapter emits `tool_result` NESTED inside a `user`
// event's content array (keyed by `tool_use_id`), not as a top-level `tool_result` event.
// This module is the ADDITIVE, PURE core that:
//   - matches tool_result → tool_use by id and attaches bounded output + success/exitCode,
//   - tags each call with its run phase (first_pass | pivot_revision),
//   - derives structured test-command events (pytest/unittest/tox/npm/bun/cargo/go) with
//     the selected tests and a CONSERVATIVE patch-state label.
//
// It NEVER changes retrieval, ranking, scoring, candidate generation, prompts, or patches,
// reads no gold labels, and is intentionally honest: when the stream does not expose an
// output / exit code, the field stays null rather than being guessed. It does NOT parse
// pytest stdout to fabricate pass/fail — `success` comes only from the stream's `is_error`.

import { isBashTool, toolCategory, type ToolCategory } from "./toolCallLog";

export type RunPhase = "first_pass" | "pivot_revision";

export type TestFramework =
  | "pytest"
  | "unittest"
  | "tox"
  | "npm"
  | "bun"
  | "cargo"
  | "go"
  | "unknown";

// Conservative patch-state labels. A test observed inside an agent loop ran BEFORE that
// phase's final patch was extracted (extraction happens after the loop ends), so we never
// claim a test verified a final/after patch — only "before" or "unknown".
export type PatchState =
  | "first_pass_before_model_patch"
  | "revision_phase_before_revised_patch"
  | "unknown";

// Strict bounds so a large Read dump / long test log cannot bloat the persisted artifact.
export const OUTPUT_MAX_BYTES = 8 * 1024; // 8k full(ish) output
export const OUTPUT_SUMMARY_MAX_BYTES = 1024; // 1k head summary

export interface EnrichedToolCall {
  index: number;
  phase: RunPhase;
  tool: string;
  category: ToolCategory;
  /** Bash/shell command, when this call is a shell tool. */
  command: string | null;
  /** Conventional file target, when present. */
  path: string | null;
  /** Bounded captured output (≤ OUTPUT_MAX_BYTES), or null when the stream had none. */
  output: string | null;
  /** Bounded head summary (≤ OUTPUT_SUMMARY_MAX_BYTES), or null. */
  outputSummary: string | null;
  /** Process exit code when the stream exposes one (rare) — else null. */
  exitCode: number | null;
  /** Success from the stream's `is_error` flag (success = !is_error) — else null. */
  success: boolean | null;
  /** True when `output` was clipped to the byte bound. */
  truncated: boolean;
}

export interface TestCommandEvent {
  phase: RunPhase;
  command: string;
  testFramework: TestFramework;
  selectedTests: string[];
  outputSummary: string | null;
  exitCode: number | null;
  success: boolean | null;
  patchState: PatchState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const PATH_KEYS = ["file_path", "filePath", "path", "file", "filename", "notebook_path"];
const COMMAND_KEYS = ["command", "cmd", "script", "command_line"];

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

// Flatten a tool_result `content` (string, or array of {type:"text",text} blocks) to text.
function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (isRecord(block) && typeof block.text === "string") parts.push(block.text);
      else parts.push(JSON.stringify(block));
    }
    return parts.join("\n");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

// Byte-aware clip (UTF-8). Returns the clipped string and whether anything was removed.
export function clipToBytes(text: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { value: text, truncated: false };
  const clipped = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return { value: clipped, truncated: true };
}

function exitCodeFrom(block: Record<string, unknown>): number | null {
  for (const key of ["exit_code", "exitCode", "returncode", "return_code", "status"]) {
    const v = block[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

interface PendingCall extends EnrichedToolCall {
  toolUseId: string | null;
}

function pushToolUse(calls: PendingCall[], block: Record<string, unknown>, phase: RunPhase): void {
  const tool = typeof block.name === "string" ? block.name : "unknown";
  const args = isRecord(block.input) ? block.input : {};
  calls.push({
    index: calls.length,
    phase,
    tool,
    category: toolCategory(tool),
    command: isBashTool(tool) ? firstString(args, COMMAND_KEYS) : null,
    path: firstString(args, PATH_KEYS),
    output: null,
    outputSummary: null,
    exitCode: null,
    success: null,
    truncated: false,
    toolUseId: typeof block.id === "string" ? block.id : null,
  });
}

function attachResult(calls: PendingCall[], block: Record<string, unknown>): void {
  const id = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
  // Prefer an id match; fall back to the most recent call still awaiting output.
  let target: PendingCall | undefined;
  if (id !== null) target = calls.find((c) => c.toolUseId === id);
  if (target === undefined) {
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i]!.output === null) { target = calls[i]; break; }
    }
  }
  if (target === undefined) return;
  const text = contentToString(block.content);
  const full = clipToBytes(text, OUTPUT_MAX_BYTES);
  const summary = clipToBytes(text, OUTPUT_SUMMARY_MAX_BYTES);
  target.output = full.value;
  target.truncated = full.truncated;
  target.outputSummary = summary.value;
  target.exitCode = exitCodeFrom(block);
  if (typeof block.is_error === "boolean") target.success = !block.is_error;
}

// Parse the captured stream-json into ENRICHED tool calls with bounded outputs, matching
// tool_result→tool_use by id. Tolerant: skips non-JSON / unexpected lines. Handles both
// the real shape (tool_result nested in `user` events) and top-level tool_use/tool_result.
export function parseEnrichedToolCalls(streamJson: string, phase: RunPhase): EnrichedToolCall[] {
  const calls: PendingCall[] = [];
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
          if (isRecord(block) && block.type === "tool_use") pushToolUse(calls, block, phase);
        }
      }
    } else if (event.type === "user") {
      const message = isRecord(event.message) ? event.message : null;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isRecord(block) && block.type === "tool_result") attachResult(calls, block);
        }
      }
    } else if (event.type === "tool_use") {
      pushToolUse(calls, event, phase);
    } else if (event.type === "tool_result") {
      attachResult(calls, event);
    }
  }
  // Drop the internal id before returning the public shape.
  return calls.map(({ toolUseId: _toolUseId, ...rest }) => rest);
}

// Classify a shell command's test framework. Returns "unknown" for non-test commands.
export function classifyTestFramework(command: string): TestFramework {
  const c = command.toLowerCase();
  if (/\bpython[0-9.]*\s+-m\s+pytest\b/.test(c) || /(^|[\s;&|(])pytest\b/.test(c)) return "pytest";
  if (/\bpython[0-9.]*\s+-m\s+unittest\b/.test(c) || /(^|[\s;&|(])unittest\b/.test(c)) return "unittest";
  if (/(^|[\s;&|(])tox\b/.test(c)) return "tox";
  if (/(^|[\s;&|(])bun\s+test\b/.test(c)) return "bun";
  if (/(^|[\s;&|(])npm\s+(run\s+)?test\b/.test(c)) return "npm";
  if (/(^|[\s;&|(])cargo\s+test\b/.test(c)) return "cargo";
  if (/(^|[\s;&|(])go\s+test\b/.test(c)) return "go";
  return "unknown";
}

export function isTestCommand(command: string): boolean {
  return classifyTestFramework(command) !== "unknown";
}

// Best-effort extraction of the selected tests from a test command. Conservative: only
// pytest/unittest yield specific selectors today (documented); others return [].
export function extractSelectedTests(command: string, framework: TestFramework): string[] {
  const tokens = command.split(/\s+/).filter((t) => t.length > 0 && !t.startsWith("-"));
  if (framework === "pytest") {
    return tokens.filter((t) => t.includes("::") || /(^|\/)(test_[^/\s]+|[^/\s]+_test)\.py$/.test(t));
  }
  if (framework === "unittest") {
    // Dotted node ids that mention a test (e.g. pkg.tests.test_x.TestY.test_z), not files.
    return tokens.filter((t) => t.includes(".") && /test/i.test(t) && !t.endsWith(".py"));
  }
  return [];
}

function patchStateForPhase(phase: RunPhase): PatchState {
  return phase === "first_pass"
    ? "first_pass_before_model_patch"
    : "revision_phase_before_revised_patch";
}

// Derive structured test-command events from enriched tool calls. One event per shell
// call whose command classifies as a known test framework. patchState is conservative
// (phase-derived "before" label) — we never assert a test ran against a final patch.
export function deriveTestCommands(calls: readonly EnrichedToolCall[]): TestCommandEvent[] {
  const events: TestCommandEvent[] = [];
  for (const call of calls) {
    if (call.command === null || !isBashTool(call.tool)) continue;
    const framework = classifyTestFramework(call.command);
    if (framework === "unknown") continue;
    events.push({
      phase: call.phase,
      command: call.command,
      testFramework: framework,
      selectedTests: extractSelectedTests(call.command, framework),
      outputSummary: call.outputSummary,
      exitCode: call.exitCode,
      success: call.success,
      patchState: patchStateForPhase(call.phase),
    });
  }
  return events;
}
