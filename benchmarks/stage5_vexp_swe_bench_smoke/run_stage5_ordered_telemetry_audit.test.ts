import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  auditOrderedTelemetry,
  renderTelemetryAuditMarkdown,
  runOrderedTelemetryAudit,
  TELEMETRY_AUDIT_JSON_FILENAME,
  TELEMETRY_AUDIT_MD_FILENAME,
  type TelemetryRunRecord,
} from "./run_stage5_ordered_telemetry_audit";
import {
  NORMALIZED_FILENAME,
  TELEMETRY_MISSING_LEGACY,
  TELEMETRY_MISSING_SENTINEL,
  toolCallLogFilePath,
  toolCallSummaryFilePath,
  type Stage5Condition,
} from "./run_stage5_vexp_swe_bench_smoke";

async function tmpResults(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `stage5-telemetry-${label}-`));
  const out = path.join(dir, "results");
  await mkdir(out, { recursive: true });
  return out;
}

// Seed a labeled condition run directory with the requested artifacts. `telemetry`
// chooses which telemetry artifacts exist (mirroring what the runner would write):
//   - "ordered" → _tool_calls.json + summary(orderedTelemetryAvailable:true)
//   - "raw"     → summary(orderedTelemetryAvailable:false, missingReason:sentinel), no log
//   - "none"    → neither (legacy run)
async function seedRun(
  out: string,
  label: string,
  condition: Stage5Condition,
  instanceId: string,
  telemetry: "ordered" | "raw" | "none",
  metaExtra: Record<string, unknown> = {},
  // When provided, write a canonical per-run result JSONL (the historical fallback
  // source). cost/tokens omitted → that metric stays unavailable in the artifact.
  resultRecord?: { cost?: number; inputTokens?: number; outputTokens?: number },
): Promise<string> {
  const dir = path.join(out, "runs", label, "raw", condition);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "_run.meta.json"),
    JSON.stringify({ condition, instances: [instanceId], exitCode: 0, ...metaExtra }, null, 2),
  );
  if (resultRecord !== undefined) {
    const record: Record<string, unknown> = {
      instanceId,
      modelPatch: "diff --git a/x b/x\n+patch\n",
      resolved: true,
    };
    if (resultRecord.cost !== undefined) record.cost = resultRecord.cost;
    if (resultRecord.inputTokens !== undefined) record.inputTokens = resultRecord.inputTokens;
    if (resultRecord.outputTokens !== undefined) record.outputTokens = resultRecord.outputTokens;
    await writeFile(path.join(dir, "swebench-2026-06-03.jsonl"), JSON.stringify(record));
  }
  if (telemetry === "ordered") {
    await writeFile(
      toolCallLogFilePath(dir),
      JSON.stringify([{ index: 0, tool: "Read", category: "read", path: "a.py", query: null, args: {}, output_summary: null }], null, 2),
    );
    await writeFile(
      toolCallSummaryFilePath(dir),
      JSON.stringify(
        {
          runLabel: label,
          condition,
          instances: [instanceId],
          instanceId,
          totalToolCalls: 1,
          bashToolCalls: 0,
          grepLikeToolCalls: 0,
          fileReadToolCalls: 1,
          fileWriteToolCalls: 0,
          uniqueFilesTouchedByTools: 1,
          longBashLoopHeuristic: false,
          repeatedSearchHeuristic: false,
          orderedTelemetryAvailable: true,
          missingReason: null,
        },
        null,
        2,
      ),
    );
  } else if (telemetry === "raw") {
    await writeFile(
      toolCallSummaryFilePath(dir),
      JSON.stringify(
        {
          runLabel: label,
          condition,
          instances: [instanceId],
          instanceId,
          totalToolCalls: 0,
          bashToolCalls: 0,
          grepLikeToolCalls: 0,
          fileReadToolCalls: 0,
          fileWriteToolCalls: 0,
          uniqueFilesTouchedByTools: 0,
          longBashLoopHeuristic: false,
          repeatedSearchHeuristic: false,
          orderedTelemetryAvailable: false,
          missingReason: TELEMETRY_MISSING_SENTINEL,
        },
        null,
        2,
      ),
    );
  }
  // "none" → only _run.meta.json (legacy run that never captured stream-json).
  return dir;
}

async function seedNormalized(out: string, rows: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(path.join(out, NORMALIZED_FILENAME), JSON.stringify({ rows }, null, 2));
}

function find(runs: readonly TelemetryRunRecord[], label: string, condition: Stage5Condition): TelemetryRunRecord {
  const run = runs.find((r) => r.runLabel === label && r.condition === condition);
  assert.ok(run, `expected run ${label}/${condition}`);
  return run;
}

test("telemetry audit marks a legacy run with no stream-json as unavailable", async () => {
  const out = await tmpResults("legacy");
  await seedRun(out, "legacy-run", "baseline", "django__django-1", "none");
  const audit = await auditOrderedTelemetry(out);
  const run = find(audit.runs, "legacy-run", "baseline");
  assert.equal(run.state, "none");
  assert.equal(run.orderedTelemetryAvailable, false);
  assert.equal(run.missingReason, TELEMETRY_MISSING_LEGACY);
  assert.equal(audit.none, 1);
});

test("telemetry audit reports a run with raw stream present but parsed log missing", async () => {
  const out = await tmpResults("raw");
  await seedRun(out, "raw-run", "vtrace", "django__django-2", "raw");
  const audit = await auditOrderedTelemetry(out);
  const run = find(audit.runs, "raw-run", "vtrace");
  assert.equal(run.state, "raw-stream-no-parsed");
  assert.equal(run.orderedTelemetryAvailable, false);
  assert.equal(run.hasOrderedLog, false);
  assert.equal(run.missingReason, TELEMETRY_MISSING_SENTINEL);
  assert.equal(audit.rawStreamNoParsed, 1);
});

test("telemetry audit counts ordered runs and joins discipline metadata", async () => {
  const out = await tmpResults("ordered");
  await seedRun(out, "ok-run", "vtrace", "django__django-3", "ordered", {
    stage5ToolUseDisciplineInjected: true,
    stage5ToolUseDisciplineVersion: "v1",
  });
  const audit = await auditOrderedTelemetry(out);
  const run = find(audit.runs, "ok-run", "vtrace");
  assert.equal(run.state, "ordered");
  assert.equal(run.orderedTelemetryAvailable, true);
  assert.equal(run.toolUseDisciplineInjected, true);
  assert.equal(audit.ordered, 1);
});

test("telemetry audit uses normalized cost/tokens when present (costSource=normalized)", async () => {
  const out = await tmpResults("highcost");
  // A high-cost legacy run (no telemetry) and a cheap legacy run.
  await seedRun(out, "expensive", "baseline", "django__django-9", "none");
  await seedRun(out, "cheap", "baseline", "django__django-8", "none");
  await seedNormalized(out, [
    { instanceId: "django__django-9", condition: "baseline", costUsd: 1.25, totalTokens: 2_000_000 },
    { instanceId: "django__django-8", condition: "baseline", costUsd: 0.01, totalTokens: 1000 },
  ]);
  const audit = await auditOrderedTelemetry(out);
  const expensive = find(audit.runs, "expensive", "baseline");
  const cheap = find(audit.runs, "cheap", "baseline");
  assert.equal(expensive.highCostMissingTelemetry, true);
  assert.equal(expensive.totalCostUsd, 1.25);
  assert.equal(expensive.costSource, "normalized");
  assert.equal(expensive.tokenSource, "normalized");
  assert.equal(expensive.highCostReason, "cost");
  assert.equal(cheap.highCostMissingTelemetry, false);
  assert.equal(audit.highCostMissing, 1);
});

test("falls back to per-run artifact cost/tokens when normalized metrics are missing", async () => {
  const out = await tmpResults("fallback");
  // No normalized artifact at all — the run's own JSONL is the only source.
  await seedRun(out, "hist", "baseline", "django__django-50", "none", {}, {
    cost: 0.91,
    inputTokens: 800_000,
    outputTokens: 60_000,
  });
  const audit = await auditOrderedTelemetry(out);
  const run = find(audit.runs, "hist", "baseline");
  assert.equal(run.totalCostUsd, 0.91);
  assert.equal(run.costSource, "run_artifact");
  assert.equal(run.totalTokens, 860_000);
  assert.equal(run.tokenSource, "run_artifact");
  // 0.91 ≥ 0.50 threshold AND telemetry missing → flagged by cost.
  assert.equal(run.highCostMissingTelemetry, true);
  assert.equal(run.highCostReason, "cost");
  assert.equal(audit.highCostMissing, 1);
});

test("leaves cost/tokens null and sources unavailable when no artifact records them", async () => {
  const out = await tmpResults("unavailable");
  // Legacy run with NO normalized row and NO result JSONL.
  await seedRun(out, "bare", "vtrace", "django__django-60", "none");
  const audit = await auditOrderedTelemetry(out);
  const run = find(audit.runs, "bare", "vtrace");
  assert.equal(run.totalCostUsd, null);
  assert.equal(run.totalTokens, null);
  assert.equal(run.costSource, "unavailable");
  assert.equal(run.tokenSource, "unavailable");
  // Unknown cost/tokens → NOT flagged as high-cost (never guessed).
  assert.equal(run.highCostMissingTelemetry, false);
  assert.equal(audit.highCostMissing, 0);
  assert.equal(audit.missingMetricsUnavailable, 1);
});

test("flags a high-token missing-telemetry run via fallback tokens when cost is unavailable", async () => {
  const out = await tmpResults("hightoken");
  // Result JSONL carries tokens but no cost field → cost unavailable, tokens fall back.
  await seedRun(out, "tokrun", "baseline", "django__django-70", "none", {}, {
    inputTokens: 1_500_000,
    outputTokens: 100_000,
  });
  const audit = await auditOrderedTelemetry(out);
  const run = find(audit.runs, "tokrun", "baseline");
  assert.equal(run.totalCostUsd, null);
  assert.equal(run.costSource, "unavailable");
  assert.equal(run.totalTokens, 1_600_000);
  assert.equal(run.tokenSource, "run_artifact");
  // cost unavailable but tokens ≥ 1,000,000 → flagged by tokens.
  assert.equal(run.highCostReason, "tokens");
  assert.equal(run.highCostMissingTelemetry, true);
  assert.equal(audit.highCostMissing, 1);
});

test("does not flag a cheap missing-telemetry run resolved from per-run artifact", async () => {
  const out = await tmpResults("cheap-artifact");
  await seedRun(out, "cheaprun", "baseline", "django__django-80", "none", {}, {
    cost: 0.02,
    inputTokens: 1000,
    outputTokens: 500,
  });
  const audit = await auditOrderedTelemetry(out);
  const run = find(audit.runs, "cheaprun", "baseline");
  assert.equal(run.totalCostUsd, 0.02);
  assert.equal(run.costSource, "run_artifact");
  assert.equal(run.highCostMissingTelemetry, false);
  assert.equal(audit.highCostMissing, 0);
});

test("does not flag an ordered (telemetry-present) run even when it is expensive", async () => {
  const out = await tmpResults("ordered-expensive");
  await seedRun(out, "ok-expensive", "vtrace", "django__django-90", "ordered", {}, {
    cost: 5.0,
    inputTokens: 3_000_000,
    outputTokens: 200_000,
  });
  const audit = await auditOrderedTelemetry(out);
  const run = find(audit.runs, "ok-expensive", "vtrace");
  // Telemetry present → never counted as high-cost MISSING telemetry.
  assert.equal(run.highCostMissingTelemetry, false);
  assert.equal(run.totalCostUsd, 5.0);
  assert.equal(audit.highCostMissing, 0);
});

test("telemetry audit surfaces loop-heuristic hits (diagnostic only)", async () => {
  const out = await tmpResults("loops");
  const dir = await seedRun(out, "loopy", "vtrace", "django__django-7", "ordered");
  // Overwrite the summary so the loop heuristics are tripped.
  await writeFile(
    toolCallSummaryFilePath(dir),
    JSON.stringify(
      {
        runLabel: "loopy",
        condition: "vtrace",
        instances: ["django__django-7"],
        instanceId: "django__django-7",
        totalToolCalls: 14,
        bashToolCalls: 9,
        grepLikeToolCalls: 6,
        fileReadToolCalls: 1,
        fileWriteToolCalls: 0,
        uniqueFilesTouchedByTools: 1,
        longBashLoopHeuristic: true,
        repeatedSearchHeuristic: true,
        orderedTelemetryAvailable: true,
        missingReason: null,
      },
      null,
      2,
    ),
  );
  const audit = await auditOrderedTelemetry(out);
  const run = find(audit.runs, "loopy", "vtrace");
  assert.equal(run.longBashLoopHeuristic, true);
  assert.equal(run.repeatedSearchHeuristic, true);
  assert.equal(audit.loopHeuristicHits, 1);
  // Heuristics are diagnostic — the run is still "ordered" (they change nothing else).
  assert.equal(run.state, "ordered");
});

test("renderTelemetryAuditMarkdown emits all required sections and non-claims", async () => {
  const out = await tmpResults("md");
  await seedRun(out, "ok-run", "vtrace", "django__django-3", "ordered");
  await seedRun(out, "legacy-run", "baseline", "django__django-1", "none");
  const audit = await auditOrderedTelemetry(out);
  const md = renderTelemetryAuditMarkdown(audit);
  for (const heading of [
    "# Stage 5 ordered telemetry audit",
    "## Summary",
    "## Coverage",
    "## Missing telemetry",
    "## High-cost runs missing telemetry",
    "## Loop heuristics",
    "## Recommendations",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  assert.match(md, /This report does not re-run agents\./);
  assert.match(md, /does not infer tool order when stream-json is missing\./);
  assert.match(md, /Loop heuristics are diagnostic only and do not affect patch generation\./);
  // New provenance line in Summary and the two new non-claims.
  assert.match(md, /resolved from normalized reports first, then per-run artifacts when available/);
  assert.match(md, /does not guess cost or token totals when no artifact records them\./);
  assert.match(md, /Fallback cost\/token extraction is for prioritization only and does not change policy accounting\./);
  // High-cost section distinguishes known vs unavailable metrics.
  assert.match(md, /Missing telemetry with known cost\/token/);
  assert.match(md, /Missing telemetry with unavailable cost\/token/);
});

test("markdown flags fallback-resolved high-cost runs and lists unavailable ones separately", async () => {
  const out = await tmpResults("md-fallback");
  await seedRun(out, "pricey", "baseline", "django__django-100", "none", {}, { cost: 1.1, inputTokens: 100, outputTokens: 50 });
  await seedRun(out, "bare", "baseline", "django__django-101", "none");
  const audit = await auditOrderedTelemetry(out);
  const md = renderTelemetryAuditMarkdown(audit);
  // Flagged run appears with its run_artifact cost source.
  assert.match(md, /pricey .*run_artifact/);
  // Unavailable run is listed in the cannot-rank subsection, not guessed.
  assert.match(md, /bare .*legacy-run-no-stream-json/);
  assert.equal(audit.highCostMissing, 1);
  assert.equal(audit.missingMetricsUnavailable, 1);
});

test("parseResultsDir accepts --results and --out", async () => {
  const { parseResultsDir } = await import("./run_stage5_ordered_telemetry_audit");
  assert.equal(parseResultsDir(["--results", "/tmp/a"]), path.resolve("/tmp/a"));
  assert.equal(parseResultsDir(["--out", "/tmp/b"]), path.resolve("/tmp/b"));
});

test("runOrderedTelemetryAudit writes both report artifacts and runs offline (no agent/model/docker calls)", async () => {
  // This test only seeds files and scans them — it never spawns a process, calls a
  // model, or touches Docker. Its passing IS the assertion that the audit is a pure
  // file scan (requirement 14).
  const out = await tmpResults("write");
  await seedRun(out, "ok-run", "vtrace", "django__django-3", "ordered");
  const audit = await runOrderedTelemetryAudit(out);
  assert.equal(audit.totalRuns, 1);
  const json = JSON.parse(await readFile(path.join(out, TELEMETRY_AUDIT_JSON_FILENAME), "utf8"));
  assert.equal(json.ordered, 1);
  const md = await readFile(path.join(out, TELEMETRY_AUDIT_MD_FILENAME), "utf8");
  assert.ok(md.startsWith("# Stage 5 ordered telemetry audit"));
});

test("telemetry audit returns an empty report for a results dir with no runs", async () => {
  const out = await tmpResults("empty");
  const audit = await auditOrderedTelemetry(out);
  assert.equal(audit.totalRuns, 0);
  assert.equal(audit.ordered, 0);
  const md = renderTelemetryAuditMarkdown(audit);
  assert.match(md, /No Stage 5 agent run directories found/);
});
