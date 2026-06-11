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
): Promise<string> {
  const dir = path.join(out, "runs", label, "raw", condition);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "_run.meta.json"),
    JSON.stringify({ condition, instances: [instanceId], exitCode: 0, ...metaExtra }, null, 2),
  );
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

test("telemetry audit identifies high-cost runs missing telemetry from the normalized artifact", async () => {
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
  assert.equal(expensive.highCost, true);
  assert.equal(expensive.costUsd, 1.25);
  assert.equal(cheap.highCost, false);
  assert.equal(audit.highCostMissing, 1);
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
