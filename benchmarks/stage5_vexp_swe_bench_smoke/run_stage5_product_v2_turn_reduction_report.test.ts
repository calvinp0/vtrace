// Tests for the Stage 5 product-v2 turn-reduction report (the first product v2
// performance gate). All fixtures — NO Docker, model, or agent calls occur.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import type { OrderedToolCall } from "../../src/capsule/toolCallLog";
import { productV2ProbeDir, productV2ProbeFilePath } from "./stage5_product_v2_probe";
import {
  analyzeProductV2Case,
  buildProductV2TurnReductionReport,
  classifyCasePass,
  loadProductV2CaseInputs,
  normalizeInstanceId,
  renderMarkdown,
  resolveLabelForInstance,
  type ConditionMetrics,
  type ProductV2CaseRecord,
} from "./run_stage5_product_v2_turn_reduction_report";

// ---- fixtures -------------------------------------------------------------

let counter = 0;
function call(tool: string, category: OrderedToolCall["category"]): OrderedToolCall {
  return { index: counter++, tool, category, path: null, query: null, args: {}, output_summary: null };
}

// Build an ordered tool-call log with the requested Read/Grep/Bash counts.
function calls(opts: { read: number; grep: number; bash: number }): OrderedToolCall[] {
  const list: OrderedToolCall[] = [];
  for (let i = 0; i < opts.read; i++) list.push(call("Read", "read"));
  for (let i = 0; i < opts.grep; i++) list.push(call("Grep", "search"));
  for (let i = 0; i < opts.bash; i++) list.push(call("Bash", "other"));
  return list;
}

function metrics(over: Partial<ConditionMetrics>): ConditionMetrics {
  return {
    resolved: true,
    totalTokens: 10000,
    inputTokens: 6000,
    outputTokens: 1000,
    cacheReadTokens: 3000,
    costUsd: 0.05,
    durationMs: 1000,
    contextEngine: null,
    toolCalls: null,
    ...over,
  };
}

// A passing case: product v2 cuts tokens, cache-read, and follow-up turns, keeps resolve.
function passingRecord(instanceId: string): ProductV2CaseRecord {
  return {
    instanceId,
    prior: metrics({
      resolved: true,
      totalTokens: 20000,
      cacheReadTokens: 8000,
      costUsd: 0.1,
      contextEngine: "legacy",
      toolCalls: calls({ read: 6, grep: 4, bash: 3 }),
    }),
    productV2: metrics({
      resolved: true,
      totalTokens: 14000,
      cacheReadTokens: 5000,
      costUsd: 0.07,
      contextEngine: "v2",
      toolCalls: calls({ read: 3, grep: 1, bash: 1 }),
    }),
    productSignals: {
      parseOk: true,
      contextEngine: "v2",
      contextEngineIsV2: true,
      capsuleV2Present: true,
      accounting: null,
    },
  };
}

// ---- per-case strict AND --------------------------------------------------

test("strict AND passes only when all four criteria improve", () => {
  const c = analyzeProductV2Case(passingRecord("django-10880"));
  assert.equal(c.pass, true);
  assert.deepEqual(c.failedCriteria, []);
  assert.equal(c.totalTokens.delta, -6000);
  assert.equal(c.cacheReadTokens.delta, -3000);
  assert.equal(c.followupCalls.delta, -8); // (3+1+1) - (6+4+3)
  assert.equal(c.readCalls.delta, -3);
  assert.equal(c.contextEngineIsV2, true);
  assert.equal(c.capsuleV2Present, true);
});

test("a token win with MORE turns does not pass strict AND", () => {
  const rec = passingRecord("x");
  const bumped: ProductV2CaseRecord = {
    ...rec,
    productV2: { ...rec.productV2, toolCalls: calls({ read: 9, grep: 4, bash: 3 }) },
  };
  const c = analyzeProductV2Case(bumped);
  assert.equal(c.pass, false);
  assert.ok(c.failedCriteria.includes("read-grep-bash-not-lower"));
});

test("resolution loss fails the case even with token/turn wins", () => {
  const rec = passingRecord("x");
  const lost: ProductV2CaseRecord = {
    ...rec,
    productV2: { ...rec.productV2, resolved: false },
  };
  const c = analyzeProductV2Case(lost);
  assert.equal(c.resolvedPreserved, false);
  assert.equal(c.pass, false);
  assert.ok(c.failedCriteria.includes("resolution-lost-or-unknown"));
});

test("classifyCasePass is strict AND of the four signals", () => {
  const good = {
    resolvedPreserved: true,
    totalTokens: { prior: 2, product: 1, delta: -1, improved: true, measurable: true },
    cacheReadTokens: { prior: 2, product: 1, delta: -1, improved: true, measurable: true },
    followupCalls: { prior: 2, product: 1, delta: -1, improved: true, measurable: true },
  };
  assert.equal(classifyCasePass(good).pass, true);
  const flatCache = { ...good, cacheReadTokens: { ...good.cacheReadTokens, delta: 0, improved: false } };
  assert.equal(classifyCasePass(flatCache).pass, false);
});

// ---- aggregate + experiment verdict ---------------------------------------

test("experiment is promising with 3/4 strict passes and aggregate wins", () => {
  const records = [
    passingRecord("matplotlib-22719"),
    passingRecord("astropy-14369"),
    passingRecord("django-10880"),
    // One regressing case (more turns) — still allowed if 3/4 pass and aggregate wins.
    (() => {
      const r = passingRecord("django-11095");
      return { ...r, productV2: { ...r.productV2, toolCalls: calls({ read: 7, grep: 4, bash: 3 }) } };
    })(),
  ];
  const report = buildProductV2TurnReductionReport(records, "2026-06-12T00:00:00Z");
  assert.equal(report.aggregate.casesPassed, 3);
  assert.equal(report.aggregate.noResolutionLoss, true);
  assert.ok((report.aggregate.totalTokensDelta ?? 0) < 0);
  assert.ok((report.aggregate.cacheReadTokensDelta ?? 0) < 0);
  assert.ok((report.aggregate.followupCallsDelta ?? 0) < 0);
  assert.equal(report.experimentVerdict, "promising");
});

test("experiment is not-promising when fewer than 3 cases pass", () => {
  const fail = (id: string): ProductV2CaseRecord => {
    const r = passingRecord(id);
    return { ...r, productV2: { ...r.productV2, totalTokens: 25000 } }; // tokens went UP
  };
  const records = [passingRecord("a"), passingRecord("b"), fail("c"), fail("d")];
  const report = buildProductV2TurnReductionReport(records, "t");
  assert.equal(report.aggregate.casesPassed, 2);
  assert.equal(report.experimentVerdict, "not-promising");
  assert.ok(report.experimentReasons.some((r) => r.includes("strict AND")));
});

test("experiment is insufficient-data when telemetry is missing", () => {
  const noTelemetry: ProductV2CaseRecord = {
    instanceId: "a",
    prior: metrics({ totalTokens: null, cacheReadTokens: null, toolCalls: null }),
    productV2: metrics({ totalTokens: null, cacheReadTokens: null, toolCalls: null }),
    productSignals: null,
  };
  const report = buildProductV2TurnReductionReport([noTelemetry], "t");
  assert.equal(report.experimentVerdict, "insufficient-data");
});

// ---- rendering ------------------------------------------------------------

// ---- on-disk loader (real artifact layout) -------------------------------

test("resolveLabelForInstance zips per-instance labels, falls back to single/all", () => {
  // Per-instance list zipped by index.
  assert.equal(resolveLabelForInstance(0, ["la", "lb", "lc"], "fb"), "la");
  assert.equal(resolveLabelForInstance(2, ["la", "lb", "lc"], "fb"), "lc");
  // Single entry applies to every instance.
  assert.equal(resolveLabelForInstance(3, ["only"], "fb"), "only");
  // Empty list -> the single fallback.
  assert.equal(resolveLabelForInstance(1, [], "fb"), "fb");
  assert.equal(resolveLabelForInstance(1, [], null), null);
});

test("normalizeInstanceId reduces canonical SWE-bench ids to the short form", () => {
  assert.equal(normalizeInstanceId("matplotlib__matplotlib-22719"), "matplotlib-22719");
  assert.equal(normalizeInstanceId("matplotlib-22719"), "matplotlib-22719");
});

test("loadProductV2CaseInputs reads the real swebench-jsonl + probe layout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "p2v-io-"));
  const canonical = "matplotlib__matplotlib-22719";
  const priorLabel = "prior-run";
  const productLabel = "product-run";

  async function writeRun(
    label: string,
    row: Record<string, unknown>,
    engine: string | null,
    toolCalls: OrderedToolCall[],
  ): Promise<string> {
    const dir = path.join(root, "runs", label, "raw", "vtrace");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "swebench-2026-06-12.jsonl"), `${JSON.stringify(row)}\n`);
    await writeFile(path.join(dir, "_run.meta.json"), JSON.stringify(engine === null ? {} : { vtraceCapsuleEngine: engine }));
    await writeFile(path.join(dir, "_tool_calls.json"), JSON.stringify(toolCalls));
    return dir;
  }

  // Prior: legacy engine, heavier tokens + turns.
  await writeRun(
    priorLabel,
    { instanceId: canonical, resolved: false, inputTokens: 200, outputTokens: 50, cacheReadTokens: 900000, cacheCreationTokens: 60000, costUsd: 0.6, durationMs: 120000 },
    "legacy",
    calls({ read: 6, grep: 4, bash: 5 }),
  );
  // Product v2: lighter tokens + turns, same resolution, with a probe file.
  await writeRun(
    productLabel,
    { instanceId: canonical, resolved: false, inputTokens: 200, outputTokens: 50, cacheReadTokens: 600000, cacheCreationTokens: 50000, costUsd: 0.4, durationMs: 90000 },
    "v2",
    calls({ read: 3, grep: 1, bash: 1 }),
  );
  // The probe lives in the LABEL dir (one level above raw/vtrace, which vexp cleans).
  const probeDir = productV2ProbeDir(root, productLabel);
  await mkdir(probeDir, { recursive: true });
  await writeFile(
    productV2ProbeFilePath(probeDir, canonical),
    JSON.stringify({ parseOk: true, contextEngine: "v2", contextEngineIsV2: true, capsuleV2Present: true, accounting: { latencyMs: 10, estimatedOutputTokens: 100 } }),
  );

  // Request by the SHORT id; the loader must still match the canonical row + probe.
  const records = await loadProductV2CaseInputs({
    resultsDir: root,
    priorLabel,
    productLabel,
    priorLabels: [],
    productLabels: [],
    instances: ["matplotlib-22719"],
    outName: "x",
  });
  assert.equal(records.length, 1);
  const rec = records[0]!;
  assert.equal(rec.prior.contextEngine, "legacy");
  assert.equal(rec.productV2.contextEngine, "v2");
  // totalTokens is summed (200+50+600000+50000), not read from a missing field.
  assert.equal(rec.productV2.totalTokens, 650250);
  assert.equal(rec.prior.totalTokens, 960250);
  assert.equal(rec.productV2.cacheReadTokens, 600000);
  assert.equal(rec.productSignals?.contextEngineIsV2, true);
  assert.equal(rec.productSignals?.capsuleV2Present, true);
  assert.ok(rec.prior.toolCalls && rec.productV2.toolCalls);

  // And the case clears strict AND with real-shaped inputs -> report is promising-capable.
  const report = buildProductV2TurnReductionReport(records, "t");
  assert.equal(report.cases[0]!.pass, true);
  assert.notEqual(report.experimentVerdict, "insufficient-data");
});

test("renderMarkdown surfaces the gate framing, verdict, and per-case table", () => {
  const report = buildProductV2TurnReductionReport([passingRecord("django-10880")], "2026-06-12T00:00:00Z");
  const md = renderMarkdown(report);
  assert.ok(md.includes("# Stage 5 — Product Capsule v2 turn-reduction gate"));
  assert.ok(md.includes("FIRST performance gate"));
  assert.ok(md.includes("not** a VEXP parity proof"));
  assert.ok(md.includes("## Experiment verdict"));
  assert.ok(md.includes("## Aggregate deltas"));
  assert.ok(md.includes("django-10880"));
  assert.ok(md.includes("Read+Grep+Bash"));
  // The accounting block must not be allowed to pass a case on its own.
  assert.ok(md.includes("does NOT by itself pass a case"));
});
