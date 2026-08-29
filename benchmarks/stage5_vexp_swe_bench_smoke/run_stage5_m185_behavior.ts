/**
 * M185-C — what the arms actually did after first contact, measured, not asserted.
 *
 * Reads M183's preserved `_tool_calls_with_outputs.json` for all 60 arms and
 * writes three artifacts:
 *
 *   stage5_m185_post_focus_behavior.json   reads/searches/edits per arm and cohort
 *   stage5_m185_validation_audit.json      who tried to run the suite, who managed it
 *   stage5_m185_controls.json              the §34 known-positive and §35 known-negative
 *
 * ONE MEASUREMENT TRAP THIS SCRIPT AVOIDS. The capture records `exitCode: null`
 * for every one of the 335 Bash calls in M183, so a "did the test run succeed"
 * metric keyed on the exit code silently returns zero for everything. Execution
 * is therefore decided from the OUTPUT — a runner banner or a pass/fail summary —
 * and an output that is only an interpreter error is not an execution.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

interface ToolCall {
  readonly index: number;
  readonly tool: string;
  readonly category: string;
  readonly command: string | null;
  readonly path: string | null;
  readonly query: string | null;
  readonly output: string | null;
  readonly truncated?: boolean;
}
interface Arm { readonly label: string; readonly rawDir: string; readonly resolved: boolean; }
interface Pair { readonly instanceId: string; readonly repo: string; readonly baseline: Arm; readonly treatment: Arm; }

const pairs: Pair[] = readFileSync(path.join(RESULTS, "stage5_m183_pair_records.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Pair);
const cohorts = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m185_cohorts.json"), "utf8")) as {
  rows: { instanceId: string; focusCohort: string; outcomeCohort: string }[];
};
const cohortOf = new Map(cohorts.rows.map((r) => [r.instanceId, r]));

const callsOf = (rawDir: string): ToolCall[] => {
  const p = path.join(REPO_ROOT, rawDir, "_tool_calls_with_outputs.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as ToolCall[]) : [];
};

// ── validation: attempted vs executed ───────────────────────────────

const SUITE = /\b(pytest|runtests\.py|tox|unittest|nosetests|bin\/test)\b/;
/** a runner banner or a result summary — evidence the suite actually ran */
const EXECUTED = /(\d+ passed|\d+ failed|PASSED|FAILED|Ran \d+ test|test session starts|^OK$)/m;
/** the environment refused before any test ran */
const ENV_REFUSAL = /No module named|command not found|can't open file|No test runner found|Failed to spawn|ModuleNotFoundError/;

interface ArmRow {
  readonly instanceId: string;
  readonly repo: string;
  readonly arm: "baseline" | "treatment";
  readonly resolved: boolean;
  readonly focusCohort: string;
  readonly outcomeCohort: string;
  readonly toolCalls: number;
  readonly reads: number;
  readonly searches: number;
  readonly edits: number;
  readonly distinctFilesRead: readonly string[];
  readonly readAnyTestFile: boolean;
  readonly firstEditIndex: number | null;
  readonly callsAfterFirstEdit: number | null;
  readonly suiteAttempts: number;
  readonly suiteExecutions: number;
  readonly suiteEnvRefusals: number;
  readonly truncatedOutputs: number;
}

const relPath = (p: string | null): string =>
  (p ?? "").split(".bench-repos/")[1]?.split("/").slice(1).join("/") ?? (p ?? "");

const rows: ArmRow[] = [];
for (const pair of pairs) {
  for (const arm of ["baseline", "treatment"] as const) {
    const rec = pair[arm];
    const tc = callsOf(rec.rawDir);
    const reads = tc.filter((t) => t.category === "read");
    const edits = tc.filter((t) => t.category === "edit");
    const firstEdit = edits.length > 0 ? edits[0]!.index : null;
    const filesRead = [...new Set(reads.map((t) => relPath(t.path)).filter((s) => s.length > 0))].sort();
    const attempts = tc.filter((t) => t.tool === "Bash" && SUITE.test(t.command ?? ""));
    const c = cohortOf.get(pair.instanceId)!;
    rows.push({
      instanceId: pair.instanceId, repo: pair.repo, arm, resolved: rec.resolved,
      focusCohort: c.focusCohort, outcomeCohort: c.outcomeCohort,
      toolCalls: tc.length, reads: reads.length,
      searches: tc.filter((t) => t.category === "search").length,
      edits: edits.length, distinctFilesRead: filesRead,
      readAnyTestFile: filesRead.some((f) => /test/i.test(f)),
      firstEditIndex: firstEdit,
      callsAfterFirstEdit: firstEdit === null ? null : tc.length - firstEdit - 1,
      suiteAttempts: attempts.length,
      suiteExecutions: attempts.filter((t) => EXECUTED.test(t.output ?? "")).length,
      suiteEnvRefusals: attempts.filter((t) => !EXECUTED.test(t.output ?? "") && ENV_REFUSAL.test(t.output ?? "")).length,
      truncatedOutputs: tc.filter((t) => t.truncated === true).length,
    });
  }
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const summarise = (label: string, sel: (r: ArmRow) => boolean) => {
  const s = rows.filter(sel);
  return {
    group: label, arms: s.length,
    medianToolCalls: median(s.map((r) => r.toolCalls)),
    medianDistinctFilesRead: median(s.map((r) => r.distinctFilesRead.length)),
    armsReadingOneFileOnly: s.filter((r) => r.distinctFilesRead.length <= 1).length,
    armsReadingATestFile: s.filter((r) => r.readAnyTestFile).length,
    armsAttemptingSuite: s.filter((r) => r.suiteAttempts > 0).length,
    armsExecutingSuite: s.filter((r) => r.suiteExecutions > 0).length,
    medianCallsAfterFirstEdit: median(s.map((r) => r.callsAfterFirstEdit ?? 0)),
  };
};

const groups = [
  summarise("ALL_ARMS", () => true),
  summarise("RESOLVED", (r) => r.resolved),
  summarise("UNRESOLVED", (r) => !r.resolved),
  summarise("T_A_CORRECT_FOCUS_FAILURE", (r) => r.arm === "treatment" && r.focusCohort === "A_CORRECT_FOCUS_FAILURE"),
  summarise("T_B_CORRECT_FOCUS_SUCCESS", (r) => r.arm === "treatment" && r.focusCohort === "B_CORRECT_FOCUS_SUCCESS"),
  summarise("T_C_WRONG_FOCUS_SUCCESS", (r) => r.arm === "treatment" && r.focusCohort === "C_WRONG_FOCUS_SUCCESS"),
  summarise("T_G_WRONG_FOCUS_FAILURE", (r) => r.arm === "treatment" && r.focusCohort === "G_WRONG_FOCUS_FAILURE"),
];

writeFileSync(path.join(RESULTS, "stage5_m185_post_focus_behavior.json"), `${JSON.stringify({
  schemaVersion: "stage5.m185.post-focus-behavior.v1", milestone: "M185", workstream: "M185-C",
  note: "§67 — counts are not causes. They bound what a transcript reading has to explain, and nothing more.",
  groups, rows,
}, null, 2)}\n`);

// ── validation audit (§26) ──────────────────────────────────────────

const validation = {
  schemaVersion: "stage5.m185.validation-audit.v1", milestone: "M185", workstream: "M185-C",
  executionCriterion: "the tool OUTPUT carries a runner banner or a pass/fail summary. exitCode is null for all 335 Bash calls in M183 and cannot be used.",
  armsTotal: rows.length,
  armsAttemptingSuite: rows.filter((r) => r.suiteAttempts > 0).length,
  armsExecutingSuite: rows.filter((r) => r.suiteExecutions > 0).length,
  armsNeverAttempting: rows.filter((r) => r.suiteAttempts === 0).length,
  attemptsTotal: rows.reduce((a, r) => a + r.suiteAttempts, 0),
  attemptsRefusedByEnvironment: rows.reduce((a, r) => a + r.suiteEnvRefusals, 0),
  executingArms: rows.filter((r) => r.suiteExecutions > 0)
    .map((r) => ({ instanceId: r.instanceId, arm: r.arm, resolved: r.resolved, attempts: r.suiteAttempts, executions: r.suiteExecutions })),
  byOutcome: {
    resolved: { arms: rows.filter((r) => r.resolved).length, executingSuite: rows.filter((r) => r.resolved && r.suiteExecutions > 0).length },
    unresolved: { arms: rows.filter((r) => !r.resolved).length, executingSuite: rows.filter((r) => !r.resolved && r.suiteExecutions > 0).length },
  },
  finding: "Validation against the repository's own tests is absent from BOTH arms and is therefore not what separates success from failure in M183. Where it was attempted it was refused by the environment, not declined by the agent.",
};
writeFileSync(path.join(RESULTS, "stage5_m185_validation_audit.json"), `${JSON.stringify(validation, null, 2)}\n`);

// ── controls (§34/§35) ──────────────────────────────────────────────

/** how much of each arm's seen-file evidence the other arm also saw */
const overlap = pairs.map((p) => {
  const b = new Set(callsOf(p.baseline.rawDir).filter((t) => t.category === "read").map((t) => relPath(t.path)));
  const t = new Set(callsOf(p.treatment.rawDir).filter((t2) => t2.category === "read").map((t2) => relPath(t2.path)));
  const inter = [...b].filter((x) => t.has(x)).length;
  const union = new Set([...b, ...t]).size;
  return { instanceId: p.instanceId, jaccard: union === 0 ? 1 : inter / union, baselineOnly: [...b].filter((x) => !t.has(x)).sort(), treatmentOnly: [...t].filter((x) => !b.has(x)).sort(), outcomeCohort: cohortOf.get(p.instanceId)!.outcomeCohort };
});

/** does a term appear anywhere in an arm's tool OUTPUT — the "was it on screen" test */
const onScreen = (rawDir: string, term: string): number => {
  let n = 0;
  for (const t of callsOf(rawDir)) n += ((t.output ?? "").split(term).length - 1);
  return n;
};

const KNOWN_POSITIVE = {
  instanceId: "pytest-dev__pytest-6197",
  fact: "Module.__init__ sets _ALLOW_MARKERS = False for __init__.py, and PyobjMixin.obj consumes it — the mechanism that makes package __init__ files collectible.",
  witness: "src/_pytest/python.py (class Module, PyobjMixin)",
  preFilter: "selected mechanically as a discordant pair with low read-set overlap, before either transcript was read",
  treatmentOnScreen: onScreen(pairs.find((p) => p.instanceId === "pytest-dev__pytest-6197")!.treatment.rawDir, "_ALLOW_MARKERS"),
  baselineOnScreen: onScreen(pairs.find((p) => p.instanceId === "pytest-dev__pytest-6197")!.baseline.rawDir, "_ALLOW_MARKERS"),
  treatmentEdited: "src/_pytest/python.py",
  baselineEdited: "src/_pytest/main.py",
  expectation: "the arm that acquired the fact edits the file the fact lives in; the arm that did not, does not",
};

const KNOWN_NEGATIVE = {
  instanceId: "django__django-12325",
  fact: "the parent-link flag lives at field.remote_field.parent_link",
  witness: "django/db/models/fields/related.py",
  preFilter: "selected mechanically as a discordant pair, before either transcript was read",
  treatmentOnScreen: onScreen(pairs.find((p) => p.instanceId === "django__django-12325")!.treatment.rawDir, "remote_field.parent_link"),
  baselineOnScreen: onScreen(pairs.find((p) => p.instanceId === "django__django-12325")!.baseline.rawDir, "remote_field.parent_link"),
  expectation: "identical decisive evidence on both sides and divergent outcomes — the classifier must return NO_MISSING_REPOSITORY_FACT rather than invent one",
};

writeFileSync(path.join(RESULTS, "stage5_m185_controls.json"), `${JSON.stringify({
  schemaVersion: "stage5.m185.controls.v1", milestone: "M185", workstream: "M185-B",
  readSetOverlap: overlap.sort((a, b) => a.jaccard - b.jaccard),
  medianJaccardByOutcome: Object.fromEntries(["BOTH_SOLVED", "F_BOTH_FAIL", "D_VTRACE_ONLY_WIN", "E_BASELINE_ONLY_WIN"]
    .map((o) => [o, median(overlap.filter((x) => x.outcomeCohort === o).map((x) => x.jaccard))])),
  knownPositive: KNOWN_POSITIVE,
  knownNegative: KNOWN_NEGATIVE,
}, null, 2)}\n`);

for (const g of groups) console.log(JSON.stringify(g));
console.log(`suite: attempted by ${validation.armsAttemptingSuite}/60, executed by ${validation.armsExecutingSuite}/60`);
console.log(`known-positive _ALLOW_MARKERS  treatment=${KNOWN_POSITIVE.treatmentOnScreen} baseline=${KNOWN_POSITIVE.baselineOnScreen}`);
console.log(`known-negative parent_link     treatment=${KNOWN_NEGATIVE.treatmentOnScreen} baseline=${KNOWN_NEGATIVE.baselineOnScreen}`);
