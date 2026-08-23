/**
 * M174-A — trace the empty-delivery fallback to its exact declining branch.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m174_empty_fallback_trace.ts
 *
 * M173 found that `run_pipeline`'s compact default has an escape hatch: when
 * `projectRunPipelineOrientation` returns null, `orientation ?? authoritativeResult`
 * hands the model the full authoritative payload — 26,075 characters on
 * matplotlib-22719, the payload M169 priced at $0.0985. It never opened in the 24
 * live M173 runs, but it is a real property of the shipped product.
 *
 * The projector declines on SEVEN distinct conditions. Six of them are failure
 * states whose authoritative envelope carries a `reason` and a `nextTool` the
 * model genuinely needs. The seventh is not a failure at all. This script
 * determines WHICH one fires, from the live product, rather than assuming.
 *
 * It captures the authoritative result once and replays every guard against the
 * saved JSON, so the classification is re-checkable without re-running the tool.
 *
 * Offline. No agent, no Docker, no paid API.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const WORKSPACES = path.join(RESULTS, "workspaces");
const DATASET = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const CAPTURE = path.join(RESULTS, "_m174_fallback_capture");

/** The case M173 observed falling back, and a case it observed staying compact. */
const SUBJECT = "matplotlib__matplotlib-22719";
const CONTROL = "mwaskom__seaborn-3187";

const labelFor = (id: string): string => `m173_vtrace_compact_${id.replace(/-/g, "_")}`;
const workspaceFor = (id: string): string => path.join(WORKSPACES, labelFor(id), id);

const problemStatements = new Map<string, string>();
for (const line of readFileSync(DATASET, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const row = JSON.parse(line) as { instance_id: string; problem_statement?: string };
  if (typeof row.problem_statement === "string") problemStatements.set(row.instance_id, row.problem_statement);
}

async function callRunPipeline(repoRoot: string, task: string): Promise<unknown> {
  const messages: unknown[] = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m174-trace", version: "1" } } },
    { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "run_pipeline", arguments: { task, repo_root: repoRoot } } },
  ];
  return await new Promise((resolve) => {
    const child = spawn("bun", ["src/cli/index.ts", "mcp-serve", "--repo", repoRoot, "--tools", "run_pipeline"], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 900_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("close", () => {
      clearTimeout(timer);
      for (const line of stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          if (row.id === 100) { resolve((row.result as { structuredContent?: unknown } | undefined)?.structuredContent ?? null); return; }
        } catch { /* not a frame */ }
      }
      resolve(null);
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

// ── the guards, transcribed in source order from orientationProjection.ts ──

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

interface Guard {
  readonly ordinal: number;
  readonly name: string;
  readonly kind: "ENVELOPE" | "FAILURE_STATE" | "EMPTY_DELIVERY";
  readonly declines: (output: unknown) => boolean;
}

const GUARDS: readonly Guard[] = [
  { ordinal: 1, name: "output is not a record", kind: "ENVELOPE", declines: (o) => !isRecord(o) },
  { ordinal: 2, name: "productContext absent", kind: "ENVELOPE", declines: (o) => isRecord(o) && !isRecord(o.productContext) },
  { ordinal: 3, name: "productContext.resolved !== true", kind: "FAILURE_STATE", declines: (o) => isRecord(o) && isRecord(o.productContext) && o.productContext.resolved !== true },
  { ordinal: 4, name: "productContext.retrievalFound === false", kind: "FAILURE_STATE", declines: (o) => isRecord(o) && isRecord(o.productContext) && o.productContext.retrievalFound === false },
  { ordinal: 5, name: "productContext.deliveryFailed === true", kind: "FAILURE_STATE", declines: (o) => isRecord(o) && isRecord(o.productContext) && o.productContext.deliveryFailed === true },
  {
    ordinal: 6, name: "diagnostics.freshness.readiness.ready !== true", kind: "FAILURE_STATE",
    declines: (o) => {
      if (!isRecord(o)) return false;
      const diagnostics = isRecord(o.diagnostics) ? o.diagnostics : {};
      const freshness = isRecord(diagnostics.freshness) ? diagnostics.freshness : {};
      const readiness = isRecord(freshness.readiness) ? freshness.readiness : null;
      return readiness !== null && readiness.ready !== true;
    },
  },
  {
    ordinal: 7, name: "no item carries an fqName (empty delivery)", kind: "EMPTY_DELIVERY",
    declines: (o) => {
      if (!isRecord(o) || !isRecord(o.productContext)) return false;
      const raw = Array.isArray(o.productContext.items) ? o.productContext.items.filter(isRecord) : [];
      return raw.filter((item) => text(item.fqName) !== "").length === 0;
    },
  },
];

function trace(output: unknown): Record<string, unknown> {
  const evaluated = GUARDS.map((g) => ({ ordinal: g.ordinal, name: g.name, kind: g.kind, declines: g.declines(output) }));
  const first = evaluated.find((g) => g.declines) ?? null;
  const pc = isRecord(output) && isRecord(output.productContext) ? output.productContext : null;
  const rawItems = pc !== null && Array.isArray(pc.items) ? pc.items.filter(isRecord) : [];
  return {
    declined: first !== null,
    decliningGuard: first,
    guards: evaluated,
    observedState: {
      serializedCharacters: JSON.stringify(output ?? null).length,
      resolved: pc?.resolved ?? null,
      retrievalFound: pc?.retrievalFound ?? null,
      deliveryFailed: pc?.deliveryFailed ?? null,
      rawItemCount: rawItems.length,
      itemsWithFqName: rawItems.filter((i) => text(i.fqName) !== "").length,
      leadPivot: pc === null ? null : (text(pc.leadPivot) === "" ? null : text(pc.leadPivot)),
      freshnessStatus: pc !== null && isRecord(pc.freshness) ? text(pc.freshness.status) : null,
      hasReason: isRecord(output) && output.reason !== undefined,
      hasNextTool: isRecord(output) && output.nextTool !== undefined,
    },
  };
}

// ── main ────────────────────────────────────────────────────────────

mkdirSync(CAPTURE, { recursive: true });
const rows: Record<string, unknown>[] = [];

for (const instanceId of [SUBJECT, CONTROL]) {
  const workspace = workspaceFor(instanceId);
  if (!existsSync(path.join(workspace, ".vtrace", "index.sqlite"))) {
    rows.push({ instanceId, error: "workspace not indexed" });
    continue;
  }
  const task = problemStatements.get(instanceId);
  if (task === undefined) { rows.push({ instanceId, error: "no problem statement" }); continue; }

  const captured = path.join(CAPTURE, `${instanceId.replace(/[^a-zA-Z0-9]/g, "_")}.json`);
  let output: unknown;
  if (existsSync(captured)) {
    output = JSON.parse(readFileSync(captured, "utf8"));
    process.stdout.write(`[cached] ${instanceId}\n`);
  } else {
    const frame = await callRunPipeline(workspace, task);
    output = (frame as { result?: { output?: unknown } } | null)?.result?.output ?? null;
    writeFileSync(captured, JSON.stringify(output, null, 1));
    process.stdout.write(`[called] ${instanceId}\n`);
  }

  const traced = trace(output);
  rows.push({ instanceId, role: instanceId === SUBJECT ? "FALLBACK_SUBJECT" : "COMPACT_CONTROL", queryCharacters: task.length, ...traced });
  const g = traced.decliningGuard as { ordinal: number; name: string; kind: string } | null;
  process.stdout.write(
    `  ${instanceId.padEnd(30)} declined=${traced.declined} `
    + `${g === null ? "(projects)" : `guard#${g.ordinal} ${g.kind} — ${g.name}`}\n`
    + `    ${JSON.stringify(traced.observedState)}\n`,
  );
}

const subject = rows.find((r) => r.role === "FALLBACK_SUBJECT");
const subjectGuard = subject?.decliningGuard as { kind: string; ordinal: number } | undefined;

const report = {
  schemaVersion: "stage5.m174.empty-fallback-trace.v1",
  milestone: "M174",
  workstream: "M174-A",
  question: "which of the projector's seven declining guards sends the model the full authoritative payload, and is that guard a failure state?",
  path: [
    "run_pipeline assembles assembledOutput",
    "compactProductResponse -> authoritativeResult",
    "projectRunPipelineOrientation(authoritativeResult) -> null",
    "return { ok: true, output: orientation ?? authoritativeResult }",
  ],
  guardTaxonomy: {
    ENVELOPE: "the value is not a run_pipeline product response at all",
    FAILURE_STATE: "resolved=false, retrieval not found, delivery failed, or index not ready — the authoritative envelope carries reason + nextTool the model needs",
    EMPTY_DELIVERY: "resolved, ready, retrieval found, delivery succeeded — and nothing projectable came back",
  },
  finding: subjectGuard === undefined
    ? "subject did not decline under this capture"
    : `the fallback observed by M173 fires on guard #${subjectGuard.ordinal}, classified ${subjectGuard.kind}`,
  rows,
};

const out = path.join(RESULTS, "stage5_m174_empty_fallback_trace.json");
writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
process.stdout.write(`\nwrote ${path.relative(ROOT, out)}\n`);
