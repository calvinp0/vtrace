/**
 * M111 hard-stratum transcript study — pure classification helpers.
 *
 * Everything here is deterministic over captured artifacts (committed detail
 * JSONs + read-only run folders). No live agents, no Docker, no network.
 * Analyst judgment fields (primary_cause, context_action_failure_type,
 * confidence, evidence_summary) are NOT computed here; they live in the
 * runner's explicit per-case override table so the machine/judgment boundary
 * stays auditable.
 */

export type AgentEditedGold = "yes" | "no" | "partial" | "unknown";

export type AgentPatchShape =
  | "no_patch"
  | "single_file_patch"
  | "multi_file_patch"
  | "wrong_file_patch"
  | "correct_file_wrong_logic"
  | "partial_patch"
  | "overbroad_patch"
  | "test_only_patch"
  | "unknown";

export type ToolLoopSignature =
  | "none"
  | "repeated_read"
  | "repeated_search"
  | "repeated_test"
  | "edit_churn"
  | "cost_cap"
  | "no_patch_exhaustion"
  | "command_failure_loop"
  | "unknown";

export type TestBehavior =
  | "no_tests_run"
  | "irrelevant_tests_run"
  | "relevant_tests_failed"
  | "relevant_tests_passed_but_eval_failed"
  | "test_command_failed_infra"
  | "unknown";

export interface OrderedToolCall {
  index: number | string;
  tool: string;
  category?: string | null;
  path?: string | null;
  args?: Record<string, unknown> | null;
  /** _tool_calls_with_outputs.json carries the Bash command at top level */
  command?: string | null;
  /** Present only in _tool_calls_with_outputs.json */
  output?: unknown;
}

export function isTestFile(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return (
    /(^|\/)tests?\//.test(p) ||
    /(^|\/)test_[^/]+$/.test(p) ||
    /_test\.[a-z]+$/.test(p)
  );
}

export function classifyEditedGold(
  changedFiles: readonly string[],
  goldFiles: readonly string[],
): { agentEditedGoldFile: AgentEditedGold; agentEditedNonGoldFile: "yes" | "no" | "unknown" } {
  if (goldFiles.length === 0) {
    return { agentEditedGoldFile: "unknown", agentEditedNonGoldFile: "unknown" };
  }
  const gold = new Set(goldFiles);
  const editedGold = changedFiles.filter((f) => gold.has(f));
  const editedNonGold = changedFiles.filter((f) => !gold.has(f));
  let agentEditedGoldFile: AgentEditedGold;
  if (editedGold.length === 0) agentEditedGoldFile = "no";
  else if (editedGold.length === goldFiles.length) agentEditedGoldFile = "yes";
  else agentEditedGoldFile = "partial";
  return {
    agentEditedGoldFile,
    agentEditedNonGoldFile: editedNonGold.length > 0 ? "yes" : "no",
  };
}

/**
 * Patch-shape decision rule (documented in the M111 plan):
 *   no_patch            — empty patch
 *   test_only_patch     — every changed file is a test file
 *   wrong_file_patch    — changed ∩ gold = ∅
 *   single_file_patch   — 1 changed file, multi-file gold (the
 *                         single-file-patch-on-multifile-gold signal)
 *   partial_patch       — >1 changed file but only some gold files covered
 *   overbroad_patch     — all gold covered plus ≥2 non-gold source files
 *   correct_file_wrong_logic — changed ⊆ gold, all gold covered, eval failed
 *   multi_file_patch    — everything else with >1 changed file
 * Unknown gold ⇒ shape falls back to file-count only.
 */
export function classifyPatchShape(
  changedFiles: readonly string[],
  goldFiles: readonly string[],
  resolved: boolean | null,
): AgentPatchShape {
  if (changedFiles.length === 0) return "no_patch";
  if (changedFiles.every((f) => isTestFile(f))) return "test_only_patch";
  if (goldFiles.length === 0) {
    return changedFiles.length === 1 ? "single_file_patch" : "multi_file_patch";
  }
  const gold = new Set(goldFiles);
  const editedGold = changedFiles.filter((f) => gold.has(f));
  const editedNonGold = changedFiles.filter((f) => !gold.has(f));
  if (editedGold.length === 0) return "wrong_file_patch";
  const allGoldCovered = editedGold.length === goldFiles.length;
  if (!allGoldCovered) {
    if (changedFiles.length === 1 && goldFiles.length > 1) return "single_file_patch";
    return "partial_patch";
  }
  if (editedNonGold.length >= 2) return "overbroad_patch";
  if (editedNonGold.length === 0 && resolved === false) return "correct_file_wrong_logic";
  return changedFiles.length === 1 ? "single_file_patch" : "multi_file_patch";
}

function bashCommand(call: OrderedToolCall): string | null {
  if (call.tool !== "Bash") return null;
  if (typeof call.command === "string" && call.command !== "None") return call.command;
  const cmd = call.args?.["command"];
  return typeof cmd === "string" ? cmd : null;
}

/** The with-outputs export serializes nulls as the string "None". */
export function callFile(call: OrderedToolCall): string {
  const fromArgs = call.args?.["file_path"];
  if (typeof fromArgs === "string" && fromArgs !== "None") return fromArgs;
  if (typeof call.path === "string" && call.path !== "None") return call.path;
  return "";
}

const TEST_COMMAND_RE =
  /pytest|runtests\.py|\bunittest\b|-m django test|\btox\b|doctest/;
const FAILURE_OUTPUT_RE =
  /Exit code [1-9]|ModuleNotFoundError|ImportError|command not found|No module named|RuntimeError/;

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND_RE.test(command);
}

/**
 * Deterministic tool-loop signature heuristics over the ordered tool calls
 * (thresholds documented in the M111 plan). Multiple signatures may fire.
 */
export function toolLoopSignatures(
  calls: readonly OrderedToolCall[],
  opts: { costUsd?: number | null; numTurns?: number | null; patchEmpty?: boolean } = {},
): ToolLoopSignature[] {
  const found = new Set<ToolLoopSignature>();

  // repeated_read: same file Read >=4 times with no intervening edit to it
  const readsSinceEdit = new Map<string, number>();
  for (const c of calls) {
    const file = callFile(c);
    if (c.tool === "Read" && file) {
      const n = (readsSinceEdit.get(file) ?? 0) + 1;
      readsSinceEdit.set(file, n);
      if (n >= 4) found.add("repeated_read");
    } else if ((c.tool === "Edit" || c.tool === "Write") && file) {
      readsSinceEdit.set(file, 0);
    }
  }

  // repeated_search: identical Grep/Glob pattern >=3 times
  const searchCounts = new Map<string, number>();
  for (const c of calls) {
    if (c.tool !== "Grep" && c.tool !== "Glob") continue;
    const pattern = String(c.args?.["pattern"] ?? c.args?.["query"] ?? "");
    if (!pattern) continue;
    const n = (searchCounts.get(pattern) ?? 0) + 1;
    searchCounts.set(pattern, n);
    if (n >= 3) found.add("repeated_search");
  }

  // repeated_test: same (normalized) test command >=3 times
  const testCounts = new Map<string, number>();
  for (const c of calls) {
    const cmd = bashCommand(c);
    if (!cmd || !isTestCommand(cmd)) continue;
    const key = cmd.replace(/\s+/g, " ").trim().slice(0, 80);
    const n = (testCounts.get(key) ?? 0) + 1;
    testCounts.set(key, n);
    if (n >= 3) found.add("repeated_test");
  }

  // edit_churn: >=3 Edit/Write calls to one file
  const editCounts = new Map<string, number>();
  for (const c of calls) {
    if (c.tool !== "Edit" && c.tool !== "Write") continue;
    const file = callFile(c);
    if (!file) continue;
    const n = (editCounts.get(file) ?? 0) + 1;
    editCounts.set(file, n);
    if (n >= 3) found.add("edit_churn");
  }

  // command_failure_loop: >=3 consecutive failing Bash calls (needs outputs)
  let consecutiveFailures = 0;
  for (const c of calls) {
    if (c.tool !== "Bash") continue; // non-Bash calls do not reset the run
    const out = typeof c.output === "string" ? c.output : "";
    if (out && FAILURE_OUTPUT_RE.test(out)) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) found.add("command_failure_loop");
    } else {
      consecutiveFailures = 0;
    }
  }

  // cost_cap proxy: near the harness spend/turn ceiling
  if ((opts.costUsd ?? 0) >= 2.5 || (opts.numTurns ?? 0) >= 90) found.add("cost_cap");

  // no_patch_exhaustion: no edits and empty patch
  const hasEdit = calls.some((c) => c.tool === "Edit" || c.tool === "Write");
  if (!hasEdit && opts.patchEmpty) found.add("no_patch_exhaustion");

  return found.size === 0 ? ["none"] : [...found].sort();
}

/**
 * Machine default for test behavior from Bash calls+outputs. The analyst
 * override table may refine this (e.g. a standalone oracle that ran real repo
 * code). Without outputs the answer is "unknown".
 */
export function classifyTestBehavior(
  callsWithOutputs: readonly OrderedToolCall[],
  resolved: boolean | null,
): TestBehavior {
  const bash = callsWithOutputs.filter((c) => c.tool === "Bash");
  if (bash.length === 0) return "no_tests_run";
  const withOutput = bash.filter((c) => typeof c.output === "string");
  const testish = bash.filter((c) => {
    const cmd = bashCommand(c) ?? "";
    // syntax-only checks are not behavior verification
    if (/py_compile|ast\.parse/.test(cmd)) return false;
    return isTestCommand(cmd) || /python3? (-c|<<|\/tmp)/.test(cmd);
  });
  if (testish.length === 0) return "no_tests_run";
  if (withOutput.length === 0) return "unknown";
  const succeeded = testish.filter((c) => {
    const out = typeof c.output === "string" ? (c.output as string) : "";
    return out !== "" && !FAILURE_OUTPUT_RE.test(out);
  });
  if (succeeded.length === 0) return "test_command_failed_infra";
  // No captured run ever executed the repo's own suite (env blackout); a
  // succeeding command here is a standalone/synthetic check. If the run still
  // failed eval, the agent's oracle passed while the real tests would not.
  return resolved === false ? "relevant_tests_passed_but_eval_failed" : "irrelevant_tests_run";
}

/** Resolve the captured run-folder label for an instance in a milestone. */
export function runFolderLabel(instanceId: string, milestone: string): string {
  const slug = instanceId.replace(/-/g, "_");
  const prefix = milestone === "m105" ? "m105_small_live" : `${milestone}_live_ext`;
  return `${prefix}_${slug}_`;
}

export function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: ReadonlyArray<Record<string, unknown>>, columns: readonly string[]): string {
  const lines = [columns.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(
      columns
        .map((c) => {
          const v = row[c];
          return csvEscape(Array.isArray(v) ? v.join("|") : v);
        })
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}
