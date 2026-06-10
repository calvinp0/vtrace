import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  type BuildTaskAuditArgs,
  type LedgerRun,
  type RawToolCall,
  type TaskAudit,
  type TokenBreakdown,
  OVERSEARCH_MIN_TOOL_CALLS,
  TOOL_LOOP_MIN_BASH_CALLS,
  REQUIRED_MARKDOWN_SECTIONS,
  buildReport,
  buildTaskAudit,
  classifyTask,
  computeAggregate,
  computeOffenders,
  computeRecommendations,
  computeToolCallStats,
  countPivotsInspected,
  loadTaskAudits,
  parseArgs,
  parseLedgerRun,
  parseRunMeta,
  renderJson,
  renderMarkdown,
} from "./run_stage5_token_path_audit";

// --- fixtures: synthetic ledger runs + tool calls (no filesystem, no agents) --

function tokens(total: number, parts: Partial<TokenBreakdown> = {}): TokenBreakdown {
  return { input: 100, output: 50, cacheRead: total - 1150, cacheCreation: 1000, total, ...parts };
}

function ledgerRun(overrides: Partial<LedgerRun> = {}): LedgerRun {
  return {
    runLabel: "eval-x",
    condition: "vtrace",
    instanceId: "repo__task-1",
    resolved: false,
    costUsd: 0.5,
    tokens: tokens(100_000),
    toolLogOrdered: false,
    toolCallCount: null,
    editedFiles: ["pkg/mod.py"],
    pivotCount: 2,
    hiddenPivotsInspected: null,
    pivotCheckInjected: null,
    editGuardInjected: null,
    patchVerifyInjected: null,
    ...overrides,
  };
}

function auditArgs(overrides: Partial<BuildTaskAuditArgs> = {}): BuildTaskAuditArgs {
  return {
    instanceId: "repo__task-1",
    baselineRunLabel: "eval-base",
    vtraceRunLabel: "eval-x",
    baseline: ledgerRun({ condition: "baseline", runLabel: "eval-base", resolved: true, costUsd: 0.4, tokens: tokens(80_000) }),
    vtrace: ledgerRun(),
    vtraceToolStats: null,
    vtraceRunMeta: null,
    criticRepairInstances: new Set<string>(),
    ...overrides,
  };
}

function syntheticToolCalls(): RawToolCall[] {
  return [
    { tool: "Read", category: "read", path: "/ws/a.py" },
    { tool: "Read", category: "read", path: "/ws/a.py" }, // repeated read
    { tool: "Read", category: "read", path: "/ws/b.py" },
    { tool: "Grep", category: "search", path: "/ws/b.py" },
    { tool: "Glob", category: "search", path: null },
    { tool: "Edit", category: "edit", path: "/ws/a.py" },
    { tool: "Edit", category: "edit", path: "/ws/a.py" },
    { tool: "Bash", category: "other" },
    { tool: "Bash", category: "other" },
  ];
}

// 1. Computes token deltas and percentages.
test("computes token deltas and percentages", () => {
  const t = buildTaskAudit(auditArgs());
  assert.equal(t.baselineTotalTokens, 80_000);
  assert.equal(t.vtraceTotalTokens, 100_000);
  assert.equal(t.tokenDelta, 20_000);
  assert.ok(Math.abs((t.tokenDeltaPct ?? 0) - 25) < 1e-9);
  // missing baseline → null deltas, never invented
  const missing = buildTaskAudit(auditArgs({ baseline: null }));
  assert.equal(missing.baselineTotalTokens, null);
  assert.equal(missing.tokenDelta, null);
  assert.equal(missing.tokenDeltaPct, null);
});

// 2. Computes cost deltas and percentages.
test("computes cost deltas and percentages", () => {
  const t = buildTaskAudit(auditArgs());
  assert.equal(t.baselineCostUsd, 0.4);
  assert.equal(t.vtraceCostUsd, 0.5);
  assert.ok(Math.abs((t.costDelta ?? 0) - 0.1) < 1e-9);
  assert.ok(Math.abs((t.costDeltaPct ?? 0) - 25) < 1e-9);
});

// 3. Counts tool calls by type from synthetic _tool_calls.json.
test("counts tool calls by type from synthetic tool log", () => {
  const stats = computeToolCallStats(syntheticToolCalls());
  assert.equal(stats.toolCallCount, 9);
  assert.equal(stats.readCallCount, 3);
  assert.equal(stats.grepCallCount, 1);
  assert.equal(stats.searchCallCount, 2); // Grep + Glob
  assert.equal(stats.editCallCount, 2);
  assert.equal(stats.bashCallCount, 2);
  assert.equal(stats.repeatedReadOrSearchCalls, 2); // a.py re-read + b.py grep-after-read
});

// 4. Counts unique files read/edited.
test("counts unique files read and edited", () => {
  const stats = computeToolCallStats(syntheticToolCalls());
  assert.equal(stats.uniqueFilesRead, 2); // a.py, b.py
  assert.equal(stats.uniqueFilesEdited, 1); // a.py (edited twice)
  // pivot-path suffix matching against absolute tool paths
  assert.equal(countPivotsInspected(["a.py", "c.py"], stats.readOrSearchPaths), 1);
});

// 5. Classifies agent_oversearched.
test("classifies agent_oversearched", () => {
  const manyCalls: RawToolCall[] = Array.from({ length: OVERSEARCH_MIN_TOOL_CALLS }, (_, i) => ({
    tool: "Read",
    category: "read",
    path: `/ws/f${i}.py`,
  }));
  const t = buildTaskAudit(auditArgs({ vtraceToolStats: computeToolCallStats(manyCalls) }));
  assert.ok(t.categories.includes("agent_oversearched"));
  // repeated reads alone also trigger it, below the call-count threshold
  const repeats: RawToolCall[] = [1, 2, 3, 4].map(() => ({ tool: "Read", category: "read", path: "/ws/same.py" }));
  const t2 = buildTaskAudit(auditArgs({ vtraceToolStats: computeToolCallStats(repeats) }));
  assert.ok(t2.categories.includes("agent_oversearched"));
});

// 5b. Classifies tool_loop_overhead from Bash-call volume.
test("classifies tool_loop_overhead", () => {
  const bashLoop: RawToolCall[] = Array.from({ length: TOOL_LOOP_MIN_BASH_CALLS }, () => ({ tool: "Bash", category: "other" }));
  const t = buildTaskAudit(auditArgs({ vtraceToolStats: computeToolCallStats(bashLoop) }));
  assert.ok(t.categories.includes("tool_loop_overhead"));
});

// 6. Classifies prompt_overhead.
test("classifies prompt_overhead", () => {
  const t = buildTaskAudit(auditArgs({ vtrace: ledgerRun({ editGuardInjected: true }) }));
  assert.ok(t.categories.includes("prompt_overhead"));
  const t2 = buildTaskAudit(auditArgs({ vtrace: ledgerRun({ patchVerifyInjected: true }) }));
  assert.ok(t2.categories.includes("prompt_overhead"));
  // a resolution improvement suppresses it (tokens bought something)
  const improved = buildTaskAudit(
    auditArgs({
      baseline: ledgerRun({ condition: "baseline", resolved: false, tokens: tokens(80_000) }),
      vtrace: ledgerRun({ resolved: true, editGuardInjected: true }),
    }),
  );
  assert.ok(!improved.categories.includes("prompt_overhead"));
  assert.ok(improved.categories.includes("necessary_complexity"));
});

// 6b. Classifies pivot_check_overhead.
test("classifies pivot_check_overhead", () => {
  const t = buildTaskAudit(auditArgs({ vtrace: ledgerRun({ pivotCheckInjected: true, hiddenPivotsInspected: 2 }) }));
  assert.ok(t.categories.includes("pivot_check_overhead"));
  const noInspection = buildTaskAudit(auditArgs({ vtrace: ledgerRun({ pivotCheckInjected: true, hiddenPivotsInspected: 0 }) }));
  assert.ok(!noInspection.categories.includes("pivot_check_overhead"));
});

// 7. Classifies retrieval_noise.
test("classifies retrieval_noise", () => {
  const wideReads: RawToolCall[] = Array.from({ length: 6 }, (_, i) => ({ tool: "Read", category: "read", path: `/ws/f${i}.py` }));
  wideReads.push({ tool: "Edit", category: "edit", path: "/ws/f0.py" });
  const t = buildTaskAudit(auditArgs({ vtraceToolStats: computeToolCallStats(wideReads), vtrace: ledgerRun({ pivotCount: 3 }) }));
  assert.ok(t.categories.includes("retrieval_noise"));
});

// 7b. Classifies cache_accounting_artifact and context_too_large.
test("classifies cache_accounting_artifact and context_too_large", () => {
  // small total delta dominated by cache creation
  const t = buildTaskAudit(
    auditArgs({
      baseline: ledgerRun({ condition: "baseline", resolved: true, tokens: tokens(100_000, { cacheCreation: 1_000 }) }),
      vtrace: ledgerRun({ tokens: tokens(110_000, { cacheCreation: 9_000 }) }),
    }),
  );
  assert.ok(t.categories.includes("cache_accounting_artifact"));

  const big = buildTaskAudit(
    auditArgs({ vtraceRunMeta: { contextChars: 25_000, capsuleEstimatedTokens: 5_000, capsulePivotPaths: [], pivotCheckInjected: null } }),
  );
  assert.ok(big.categories.includes("context_too_large"));
});

// 7c. Negative deltas are not overhead cases.
test("does not classify tasks where vtrace used fewer tokens", () => {
  const t = buildTaskAudit(auditArgs({ vtrace: ledgerRun({ tokens: tokens(60_000) }) }));
  assert.deepEqual([...t.categories], []);
});

// 8. Handles missing artifacts with null/unknown.
test("handles missing artifacts with null fields and unknown classification", () => {
  // pair with token totals but no tool log / run meta and no trigger → unknown
  const t = buildTaskAudit(auditArgs());
  assert.deepEqual([...t.categories], ["unknown"]);
  assert.equal(t.toolCallCount, null);
  assert.equal(t.readCallCount, null);
  assert.equal(t.uniqueFilesRead, null);
  assert.equal(t.pivotsInspected, null);
  assert.equal(t.contextChars, null);
  assert.equal(t.vtraceEditGuardInjected, null);

  // no runs at all → token fields null, classification unknown
  const empty = buildTaskAudit(auditArgs({ baseline: null, vtrace: null, criticRepairInstances: null }));
  assert.equal(empty.vtraceTotalTokens, null);
  assert.equal(empty.tokenDelta, null);
  assert.equal(empty.vtracePatchCriticRan, null);
  assert.equal(empty.vtracePatchRepairRan, null);
  assert.deepEqual([...empty.categories], ["unknown"]);
});

// 8b. End-to-end loader tolerates a results dir with only the plan present.
test("loader tolerates missing ledger/accounting/per-run artifacts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "token-audit-"));
  try {
    await writeFile(
      path.join(dir, "stage5_controlled_10_task_plan.json"),
      JSON.stringify({ selectedTasks: [{ instanceId: "a", baselineRunLabel: "eval-a", vtraceRunLabel: "eval-a" }] }),
    );
    const audits = await loadTaskAudits(dir);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.vtraceTotalTokens, null);
    assert.deepEqual([...audits[0]!.categories], ["unknown"]);
    await assert.rejects(() => loadTaskAudits(path.join(dir, "nope")), /No controlled-task plan/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 8c. Loader joins plan, ledger, tool log, run meta, and accounting from disk.
test("loader joins per-run artifacts when present", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "token-audit-full-"));
  try {
    await writeFile(
      path.join(dir, "stage5_controlled_10_task_plan.json"),
      JSON.stringify({ selectedTasks: [{ instanceId: "repo__task-1", baselineRunLabel: "eval-b", vtraceRunLabel: "eval-v" }] }),
    );
    await writeFile(
      path.join(dir, "stage5_outcome_ledger.json"),
      JSON.stringify({
        runs: [
          { runLabel: "eval-b", condition: "baseline", instanceId: "repo__task-1", resolved: true, cost: 0.4, tokens: { input: 1, output: 2, cacheRead: 70_000, cacheCreation: 9_997, total: 80_000 }, editedFiles: ["a.py"] },
          { runLabel: "eval-v", condition: "vtrace", instanceId: "repo__task-1", resolved: false, cost: 0.5, tokens: { input: 2, output: 3, cacheRead: 89_995, cacheCreation: 10_000, total: 100_000 }, editedFiles: ["a.py"], pivotCount: 2, hiddenPivotsInspected: 1, pivotCheckInjected: true },
        ],
      }),
    );
    await writeFile(
      path.join(dir, "stage5_policy_accounting.json"),
      JSON.stringify({ conversions: [{ instanceId: "repo__task-1", runLabel: "eval-repair" }] }),
    );
    const rawDir = path.join(dir, "runs", "eval-v", "raw", "vtrace");
    await mkdir(rawDir, { recursive: true });
    await writeFile(rawDir + "/_tool_calls.json", JSON.stringify(syntheticToolCalls()));
    await writeFile(
      rawDir + "/_run.meta.json",
      JSON.stringify({ vtraceContextChars: 4784, vtraceCapsuleEstimatedTokens: 914, vtraceCapsulePivots: [{ path: "a.py" }, { path: "z.py" }], vtracePivotCheckInjected: true }),
    );

    const audits = await loadTaskAudits(dir);
    const t = audits[0]!;
    assert.equal(t.tokenDelta, 20_000);
    assert.equal(t.toolCallCount, 9);
    assert.equal(t.uniqueFilesRead, 2);
    assert.equal(t.pivotsSurfaced, 2);
    assert.equal(t.pivotsInspected, 1); // a.py visited, z.py not
    assert.equal(t.hiddenPivotsInspected, 1);
    assert.equal(t.contextChars, 4784);
    assert.equal(t.vtracePivotCheckInjected, true);
    assert.equal(t.vtracePatchCriticRan, true);
    assert.equal(t.vtracePatchRepairRan, true);
    assert.ok(t.categories.includes("pivot_check_overhead"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 9. Emits required Markdown sections.
test("emits required markdown sections", () => {
  const report = buildReport({ generatedAt: "2026-06-10T00:00:00.000Z", tasks: [buildTaskAudit(auditArgs())] });
  const md = renderMarkdown(report);
  for (const section of REQUIRED_MARKDOWN_SECTIONS) {
    assert.ok(md.includes(`${section}\n`), `missing markdown section: ${section}`);
  }
});

// 10. Emits required JSON fields.
test("emits required json fields", () => {
  const report = buildReport({ generatedAt: "2026-06-10T00:00:00.000Z", tasks: [buildTaskAudit(auditArgs())] });
  const parsed = JSON.parse(renderJson(report)) as Record<string, unknown>;
  for (const key of ["generatedAt", "summary", "tasks", "aggregate", "offenders", "recommendations", "nonClaims"]) {
    assert.ok(key in parsed, `missing top-level json field: ${key}`);
  }
  const task = (parsed.tasks as Array<Record<string, unknown>>)[0]!;
  for (const key of [
    "instanceId",
    "baselineRunLabel",
    "vtraceRunLabel",
    "baselineTotalTokens",
    "vtraceTotalTokens",
    "tokenDelta",
    "tokenDeltaPct",
    "baselineCostUsd",
    "vtraceCostUsd",
    "costDelta",
    "costDeltaPct",
    "baselineResolved",
    "vtraceResolved",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheCreationTokens",
    "toolCallCount",
    "readCallCount",
    "grepCallCount",
    "searchCallCount",
    "editCallCount",
    "bashCallCount",
    "uniqueFilesRead",
    "uniqueFilesEdited",
    "pivotsSurfaced",
    "pivotsInspected",
    "hiddenPivotsInspected",
    "vtracePivotCheckInjected",
    "vtraceEditGuardInjected",
    "vtracePatchVerifyInjected",
    "vtracePatchCriticRan",
    "vtracePatchRepairRan",
    "categories",
  ]) {
    assert.ok(key in task, `missing per-task json field: ${key}`);
  }
});

// 10b. Offenders are sorted by token delta; recommendations are evidence-gated and ranked.
test("offenders sort by delta and recommendations fire only on evidence", () => {
  const small = buildTaskAudit(auditArgs());
  const big = buildTaskAudit(
    auditArgs({
      instanceId: "repo__task-2",
      vtrace: ledgerRun({ instanceId: "repo__task-2", tokens: tokens(200_000), pivotCheckInjected: true, hiddenPivotsInspected: 2 }),
    }),
  );
  const big2 = buildTaskAudit(
    auditArgs({
      instanceId: "repo__task-3",
      vtrace: ledgerRun({ instanceId: "repo__task-3", tokens: tokens(150_000), pivotCheckInjected: true, hiddenPivotsInspected: 1 }),
    }),
  );
  const tasks = [small, big, big2];
  const offenders = computeOffenders(tasks);
  assert.deepEqual(offenders.map((o) => o.instanceId), ["repo__task-2", "repo__task-3", "repo__task-1"]);

  const recs = computeRecommendations(tasks, computeAggregate(tasks));
  assert.ok(recs.some((r) => r.title.includes("PIVOT_CHECK conditional")), "pivot-check recommendation should fire (2 tasks)");
  assert.ok(recs.some((r) => r.title.includes("ordered tool logs")), "telemetry recommendation should fire (unknown case)");
  assert.ok(!recs.some((r) => r.title.includes("EDIT_GUARD/PATCH_VERIFY")), "no guard evidence → no guard recommendation");
  assert.deepEqual(recs.map((r) => r.rank), recs.map((_, i) => i + 1));
  // ranked by token mass, largest lever first
  for (let i = 1; i < recs.length; i += 1) assert.ok(recs[i - 1]!.tokenMass >= recs[i]!.tokenMass);
});

// 10c. Parsing helpers tolerate real artifact shapes.
test("parses ledger run and run meta shapes", () => {
  const r = parseLedgerRun({ runLabel: "l", condition: "vtrace", instanceId: "i", resolved: true, cost: 1.5, tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, total: 10 }, toolLogOrdered: true, toolCallCount: 7, editedFiles: ["a.py"], pivotCount: 2, hiddenPivotsInspected: 1, pivotCheckInjected: true, editGuardInjected: null, patchVerifyInjected: false });
  assert.equal(r.costUsd, 1.5);
  assert.equal(r.tokens.total, 10);
  assert.equal(r.patchVerifyInjected, false);

  const meta = parseRunMeta({ vtraceContextChars: 100, vtraceCapsuleEstimatedTokens: 200, vtraceCapsulePivots: [{ path: "x.py" }, { bogus: 1 }], vtracePivotCheckInjected: true });
  assert.equal(meta.contextChars, 100);
  assert.deepEqual([...meta.capsulePivotPaths], ["x.py"]);

  const cfg = parseArgs(["--results", "r", "--out-name", "o"]);
  assert.equal(cfg.resultsDir, "r");
  assert.equal(cfg.outName, "o");
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});

// 11. Does not call Docker/model/agent in tests (or in the audit module itself).
test("audit module spawns nothing: no docker, model, or agent invocation", async () => {
  const source = await readFile(path.join(import.meta.dir, "run_stage5_token_path_audit.ts"), "utf8");
  for (const banned of ["child_process", "Bun.spawn", "execSync", "spawnSync", "docker ", "anthropic", "claude -"]) {
    assert.ok(!source.includes(banned), `audit module must not reference ${banned}`);
  }
  // classification is pure — runs on a plain object with no I/O
  const pure: TaskAudit = { ...buildTaskAudit(auditArgs()) };
  const { categories } = classifyTask(pure);
  assert.ok(categories.length >= 1);
});
