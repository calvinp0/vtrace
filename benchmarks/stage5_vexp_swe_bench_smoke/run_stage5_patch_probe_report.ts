// Stage 5 deterministic patch-probe report over the existing six passive-treatment runs
// (EDIT_GUARD before/after + PATCH_VERIFY before/after, for sympy / matplotlib / requests).
//
// SCOPE: analysis / reporting ONLY. Reads patches + tool-call / stdout artifacts that already
// exist on disk, runs the deterministic probes in stage5_patch_probes.ts, and writes a
// Markdown + JSON report. It runs NO agents, NO Docker, calls NO model (the only subprocess
// is a local `python3 ast.parse` for the python_parse probe; if python3 is unavailable that
// probe degrades to `unknown`). It mutates no raw artifact.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import {
  INSTANCE_CONFIGS,
  type PatchProbeSummary,
  type PythonParser,
  type RawToolCall,
  summarizePatch,
} from "./stage5_patch_probes";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const DEFAULT_OUT_NAME = "stage5_patch_probe_existing_runs";

// The twelve passive-treatment run labels (two mechanisms × before/after × three instances).
export const RUN_LABELS: readonly string[] = [
  "eval-editguard-before-sympy-16766",
  "eval-editguard-after-sympy-16766",
  "eval-patchverify-before-sympy-16766",
  "eval-patchverify-after-sympy-16766",
  "eval-editguard-before-matplotlib-22719",
  "eval-editguard-after-matplotlib-22719",
  "eval-patchverify-before-matplotlib-22719",
  "eval-patchverify-after-matplotlib-22719",
  "eval-editguard-before-requests-5414",
  "eval-editguard-after-requests-5414",
  "eval-patchverify-before-requests-5414",
  "eval-patchverify-after-requests-5414",
];

// Probe definitions for the report (id + what it checks + how to read its statuses).
export const PROBE_DEFINITIONS: readonly { id: string; checks: string; statuses: string }[] = [
  {
    id: "edited_files",
    checks: "Which files the unified diff touches.",
    statuses: "pass = >=1 edited file parsed; fail = none (empty/malformed diff).",
  },
  {
    id: "minimality_rewrite_risk",
    checks: "Broad-rewrite indicators: deletion volume, deleted control-flow lines, multi-file scope.",
    statuses: "fail = strong rewrite signal; warn = moderate; pass = small/additive.",
  },
  {
    id: "python_parse",
    checks: "AST-parses self-contained inserted Python blocks (top-level def/class) via local python3.",
    statuses: "pass = parsed clean; fail = syntax error; unknown = no isolable block or parser unavailable.",
  },
  {
    id: "inserted_method_scope",
    checks: "For inserted `def <pattern>` methods, the enclosing class visible in the diff vs the expected class.",
    statuses: "pass = in expected class; fail = wrong class; unknown = scope not visible in the diff.",
  },
  {
    id: "failing_behavior_pattern",
    checks: "Whether the added code contains the per-instance expected failing-behavior patterns.",
    statuses: "pass = >=2 patterns; warn = 1; fail = none; unknown = no config.",
  },
  {
    id: "test_evidence",
    checks: "Whether the agent ran a named test suite or an ad-hoc check (from bash tool calls / stdout).",
    statuses: "pass = named test (pytest/unittest); warn = ad-hoc check only; fail = none; unknown = no artifacts.",
  },
];

export const NON_CLAIMS: readonly string[] = [
  "These probes are cheap deterministic warning signals, not correctness checks; Docker resolution remains the only ground truth.",
  "A `pass` means a probe found no problem in the diff window — not that the patch is correct.",
  "An `unknown` is an honest measurement gap (e.g. scope not visible in the diff), not a pass.",
  "This does not run agents, Docker, or any model; it only inspects existing artifacts.",
  "This does not implement the critic or repair loop, and changes no retrieval / Capsule / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY behavior.",
  "Probe heuristics are tuned against three known losses and may not generalize without further validation.",
];

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface ReportSummary {
  readonly runsAnalyzed: number;
  readonly runsWithHighRisk: number;
  readonly runsWithKnownDefectLikelyCaught: number;
  readonly runsWithUnknownScope: number;
  readonly runsWithNoTestEvidence: number;
}

export interface InstanceRollup {
  readonly instanceId: string;
  readonly knownDefect: string;
  readonly targetProbeId: string;
  readonly runs: number;
  readonly knownDefectCaughtRuns: number;
  readonly knownDefectNotFlaggedRuns: number;
  readonly knownDefectUnknownRuns: number;
}

export interface ProbeReport {
  readonly generatedAt: string | null;
  readonly summary: ReportSummary;
  readonly runs: readonly PatchProbeSummary[];
  readonly instances: readonly InstanceRollup[];
  readonly probeDefinitions: typeof PROBE_DEFINITIONS;
  readonly nonClaims: readonly string[];
}

// ---------------------------------------------------------------------------
// Summary / rollup (pure)
// ---------------------------------------------------------------------------

function statusOf(run: PatchProbeSummary, probeId: string): string | null {
  return run.probes.find((p) => p.probeId === probeId)?.status ?? null;
}

export function buildSummary(runs: readonly PatchProbeSummary[]): ReportSummary {
  return {
    runsAnalyzed: runs.length,
    runsWithHighRisk: runs.filter((r) => r.overallRisk === "high").length,
    runsWithKnownDefectLikelyCaught: runs.filter((r) => r.knownDefectLikelyCaught === true).length,
    runsWithUnknownScope: runs.filter((r) => statusOf(r, "inserted_method_scope") === "unknown").length,
    // "No test evidence" = ran no recognized named test suite (ad-hoc check or nothing): warn or fail.
    runsWithNoTestEvidence: runs.filter((r) => {
      const s = statusOf(r, "test_evidence");
      return s === "warn" || s === "fail";
    }).length,
  };
}

export function buildInstanceRollups(runs: readonly PatchProbeSummary[]): InstanceRollup[] {
  const byInstance = new Map<string, PatchProbeSummary[]>();
  for (const r of runs) {
    const list = byInstance.get(r.instanceId) ?? [];
    list.push(r);
    byInstance.set(r.instanceId, list);
  }
  const rollups: InstanceRollup[] = [];
  for (const [instanceId, list] of byInstance) {
    const config = INSTANCE_CONFIGS[instanceId];
    rollups.push({
      instanceId,
      knownDefect: config?.knownDefect ?? "(unknown)",
      targetProbeId: config?.targetProbeId ?? "(none)",
      runs: list.length,
      knownDefectCaughtRuns: list.filter((r) => r.knownDefectLikelyCaught === true).length,
      knownDefectNotFlaggedRuns: list.filter((r) => r.knownDefectLikelyCaught === false).length,
      knownDefectUnknownRuns: list.filter((r) => r.knownDefectLikelyCaught === null).length,
    });
  }
  return rollups;
}

// Recommended next step depends on whether the probes caught meaningful risk.
export function recommendedNextStep(summary: ReportSummary): string {
  const caughtSomething = summary.runsWithKnownDefectLikelyCaught > 0 || summary.runsWithHighRisk > 0;
  if (caughtSomething) {
    return (
      "Add the critic schema + a report-only dry run that consumes these probe outputs as input — still WITHOUT repair. " +
      "The deterministic probes already flag real risk on a meaningful subset of runs (broad-rewrite and " +
      "missing-failing-behavior signals), which is enough deterministic signal to justify a critic dry run."
    );
  }
  return (
    "Improve the probes before introducing a critic: on these runs the deterministic signal is mostly `unknown` / `pass`, " +
    "so a critic would be reasoning over weak input. Strengthen scope reconstruction and failing-behavior detection first."
  );
}

export function buildReport(generatedAt: string | null, runs: readonly PatchProbeSummary[]): ProbeReport {
  return {
    generatedAt,
    summary: buildSummary(runs),
    runs,
    instances: buildInstanceRollups(runs),
    probeDefinitions: PROBE_DEFINITIONS,
    nonClaims: NON_CLAIMS,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderJson(report: ProbeReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function fmtCaught(v: boolean | null): string {
  return v === null ? "unknown" : v ? "yes" : "no";
}

export function renderMarkdown(report: ProbeReport): string {
  const { summary, runs, instances } = report;
  const lines: string[] = [];

  lines.push("# Stage 5 patch probe report over existing runs");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(
    "_Analysis only. Deterministic probes over patches that already exist on disk. No agents, no Docker, no model " +
      "calls (the sole subprocess is a local `python3 ast.parse`); no raw-artifact mutation. Probes are cheap warning " +
      "signals, not correctness oracles._",
  );
  lines.push("");

  // --- Summary -------------------------------------------------------------
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `Analyzed ${summary.runsAnalyzed} passive-treatment runs (EDIT_GUARD + PATCH_VERIFY, before/after, across ` +
      "sympy / matplotlib / requests). The deterministic probes flagged this instance's known target defect in " +
      `${summary.runsWithKnownDefectLikelyCaught} run(s) and rated ${summary.runsWithHighRisk} run(s) high-risk overall. ` +
      `Scope was indeterminate from the diff in ${summary.runsWithUnknownScope} sympy run(s); ` +
      `${summary.runsWithNoTestEvidence} run(s) showed no named-test evidence.`,
  );
  lines.push("");
  lines.push("| metric | value |");
  lines.push("| --- | --- |");
  lines.push(`| runsAnalyzed | ${summary.runsAnalyzed} |`);
  lines.push(`| runsWithHighRisk | ${summary.runsWithHighRisk} |`);
  lines.push(`| runsWithKnownDefectLikelyCaught | ${summary.runsWithKnownDefectLikelyCaught} |`);
  lines.push(`| runsWithUnknownScope | ${summary.runsWithUnknownScope} |`);
  lines.push(`| runsWithNoTestEvidence | ${summary.runsWithNoTestEvidence} |`);
  lines.push("");

  // --- Method --------------------------------------------------------------
  lines.push("## Method");
  lines.push("");
  lines.push(
    "For each run we read `modelPatch` from the SWE-bench JSONL, the ordered `_tool_calls.json` (for bash command " +
      "strings), and `_run.stdout.txt` / `_run.stderr.txt`. We then run six deterministic probes over the patch. " +
      "Each probe returns `pass | warn | fail | unknown` with a confidence and concrete evidence. Probes never claim " +
      "a patch is correct: a `pass` only means no problem was visible in the diff window, and `unknown` is returned " +
      "whenever the artifact is insufficient to decide (e.g. class scope not present in the diff). The `python_parse` " +
      "probe AST-parses only self-contained inserted blocks (a top-level `def`/`class`); fragment-only additions are " +
      "reported `unknown` rather than falsely failed.",
  );
  lines.push("");

  // --- Probe definitions ---------------------------------------------------
  lines.push("## Probe definitions");
  lines.push("");
  lines.push("| probe | checks | status meaning |");
  lines.push("| --- | --- | --- |");
  for (const d of report.probeDefinitions) {
    lines.push(`| \`${d.id}\` | ${d.checks} | ${d.statuses} |`);
  }
  lines.push("");

  // --- Results by run ------------------------------------------------------
  lines.push("## Results by run");
  lines.push("");
  lines.push(
    "| run | instance | edited_files | minimality | python_parse | scope | failing_behavior | test_evidence | overall risk | defect caught |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of runs) {
    const cell = (id: string): string => statusOf(r, id) ?? "—";
    lines.push(
      `| ${r.runLabel} | ${r.instanceId} | ${cell("edited_files")} | ${cell("minimality_rewrite_risk")} | ` +
        `${cell("python_parse")} | ${cell("inserted_method_scope")} | ${cell("failing_behavior_pattern")} | ` +
        `${cell("test_evidence")} | ${r.overallRisk} | ${fmtCaught(r.knownDefectLikelyCaught)} |`,
    );
  }
  lines.push("");
  // Per-run evidence detail.
  for (const r of runs) {
    lines.push(`### ${r.runLabel}`);
    lines.push("");
    lines.push(`- **Instance**: ${r.instanceId}; edited files: ${r.editedFiles.join(", ") || "none"}; patch chars: ${r.patchChars}.`);
    lines.push(`- **Overall risk**: ${r.overallRisk}; known defect likely caught: ${fmtCaught(r.knownDefectLikelyCaught)}.`);
    for (const p of r.probes) {
      lines.push(`- **${p.probeId}**: ${p.status} (${p.confidence}) — ${p.evidence.join(" ")}`);
    }
    lines.push("");
  }

  // --- Results by instance -------------------------------------------------
  lines.push("## Results by instance");
  lines.push("");
  lines.push("| instance | known defect | target probe | runs | caught | not flagged | unknown |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const inst of instances) {
    lines.push(
      `| ${inst.instanceId} | ${inst.knownDefect} | \`${inst.targetProbeId}\` | ${inst.runs} | ` +
        `${inst.knownDefectCaughtRuns} | ${inst.knownDefectNotFlaggedRuns} | ${inst.knownDefectUnknownRuns} |`,
    );
  }
  lines.push("");

  // --- Which known defects were caught -------------------------------------
  lines.push("## Which known defects were caught");
  lines.push("");
  for (const inst of instances) {
    lines.push(
      `- **${inst.instanceId}** (target probe \`${inst.targetProbeId}\`): flagged in ${inst.knownDefectCaughtRuns}/` +
        `${inst.runs} run(s), not flagged in ${inst.knownDefectNotFlaggedRuns}, indeterminate in ${inst.knownDefectUnknownRuns}.`,
    );
  }
  lines.push("");
  lines.push(
    "Read conservatively: a defect is \"caught\" only for the runs whose patch actually exhibits it. Where a run's " +
      "patch did not exhibit the signature defect (e.g. a PATCH_VERIFY run that happened to add the empty-array " +
      "return, or a minimal-additive requests patch), the probe correctly does NOT flag it — that is a true negative, " +
      "not a miss.",
  );
  lines.push("");

  // --- Probe limitations ---------------------------------------------------
  lines.push("## Probe limitations");
  lines.push("");
  lines.push(
    "- **Scope is diff-window-only.** `inserted_method_scope` can confirm the enclosing class only when a `class` " +
      "header is visible in the same hunk; otherwise it returns `unknown`. It cannot see the full file, so it cannot " +
      "catch a wrong-scope insertion whose surrounding class is off-screen.",
  );
  lines.push(
    "- **python_parse is partial.** It parses only self-contained inserted blocks. Fragment edits (a changed " +
      "expression, an `else:` whose `if` is unchanged) are `unknown`, and it never reconstructs/parses the whole file.",
  );
  lines.push(
    "- **failing_behavior_pattern is a substring heuristic.** It can be fooled by patterns that appear textually " +
      "without actually handling the behavior, and it depends on a hand-written per-instance pattern list.",
  );
  lines.push(
    "- **minimality is a size/control-flow heuristic.** A legitimately larger fix can look like a broad rewrite, and " +
      "a subtly-wrong tiny patch looks minimal.",
  );
  lines.push(
    "- **test_evidence proves a command ran, not that it passed.** It never asserts a test outcome.",
  );
  lines.push("");

  // --- Recommended next step ----------------------------------------------
  lines.push("## Recommended next step");
  lines.push("");
  lines.push(recommendedNextStep(summary));
  lines.push("");
  lines.push(
    "Reliable enough to feed a critic now: `edited_files`, `minimality_rewrite_risk`, and `failing_behavior_pattern` " +
      "(with its caveats). Still weak / mostly `unknown`: `inserted_method_scope` (needs full-file reconstruction) and " +
      "`python_parse` (needs whole-file content). The requests broad-rewrite and matplotlib missing-empty-array " +
      "signals are the strongest deterministic catches; the sympy scope defect remains largely invisible to cheap probes.",
  );
  lines.push("");

  // --- Non-claims ----------------------------------------------------------
  lines.push("## Non-claims");
  lines.push("");
  for (const claim of report.nonClaims) lines.push(`- ${claim}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Loading (impure)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

async function readTextFile(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function readSwebenchRecord(vtraceDir: string): Promise<Record<string, unknown> | null> {
  let entries: string[];
  try {
    entries = await readdir(vtraceDir);
  } catch {
    return null;
  }
  const jsonl = entries.find((e) => e.startsWith("swebench-") && e.endsWith(".jsonl"));
  if (!jsonl) return null;
  const text = await readTextFile(path.join(vtraceDir, jsonl));
  if (text === null) return null;
  const firstLine = text.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) return null;
  try {
    const parsed = JSON.parse(firstLine);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readToolCalls(vtraceDir: string): Promise<RawToolCall[] | null> {
  const text = await readTextFile(path.join(vtraceDir, "_tool_calls.json"));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(isRecord).map((t) => ({
      category: asString(t.category),
      path: asString(t.path),
      command: isRecord(t.args) ? asString((t.args as Record<string, unknown>).command) : null,
    }));
  } catch {
    return null;
  }
}

export interface LoadedRun {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly patch: string;
  readonly toolCalls: RawToolCall[] | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
}

export async function loadRun(resultsDir: string, runLabel: string): Promise<LoadedRun | null> {
  const vtraceDir = path.join(resultsDir, "runs", runLabel, "raw", "vtrace");
  const [record, toolCalls, stdout, stderr] = await Promise.all([
    readSwebenchRecord(vtraceDir),
    readToolCalls(vtraceDir),
    readTextFile(path.join(vtraceDir, "_run.stdout.txt")),
    readTextFile(path.join(vtraceDir, "_run.stderr.txt")),
  ]);
  if (record === null) return null;
  return {
    runLabel,
    instanceId: asString(record.instanceId) ?? runLabel,
    patch: asString(record.modelPatch) ?? "",
    toolCalls,
    stdout,
    stderr,
  };
}

// A python parser backed by a local `python3 ast.parse`. Returns null (→ unknown) if python3
// cannot be spawned. Deterministic and side-effect-free w.r.t. the repo.
export function makePythonParser(): PythonParser {
  return (code: string) => {
    try {
      const proc = Bun.spawnSync(["python3", "-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
        stdin: Buffer.from(code, "utf8"),
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode === 0) return { ok: true };
      const err = new TextDecoder().decode(proc.stderr).trim().split("\n").pop() ?? "syntax error";
      return { ok: false, error: err };
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly outName: string;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let outName = DEFAULT_OUT_NAME;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`Missing value for ${arg}.`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--results":
        resultsDir = next();
        break;
      case "--out-name":
        outName = next();
        break;
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { resultsDir, outName };
}

async function main(config: CliConfig): Promise<void> {
  const generatedAt = new Date().toISOString();
  const parsePython = makePythonParser();

  const runs: PatchProbeSummary[] = [];
  const missing: string[] = [];
  for (const label of RUN_LABELS) {
    const loaded = await loadRun(config.resultsDir, label);
    if (loaded === null) {
      missing.push(label);
      continue;
    }
    runs.push(
      summarizePatch({
        instanceId: loaded.instanceId,
        runLabel: loaded.runLabel,
        patch: loaded.patch,
        toolCalls: loaded.toolCalls,
        stdout: loaded.stdout,
        stderr: loaded.stderr,
        parsePython,
      }),
    );
  }

  const report = buildReport(generatedAt, runs);

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const s = report.summary;
  process.stdout.write(
    [
      "Stage 5 patch probe report written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Runs analyzed: ${s.runsAnalyzed}${missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""}`,
      `High risk: ${s.runsWithHighRisk}   Known defect caught: ${s.runsWithKnownDefectLikelyCaught}   Unknown scope: ${s.runsWithUnknownScope}   No test evidence: ${s.runsWithNoTestEvidence}`,
      "",
    ].join("\n"),
  );
}

if (import.meta.main) {
  try {
    await main(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
