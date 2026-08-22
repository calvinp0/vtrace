/**
 * M169-D — run the evidence-dose ladder through the REAL packer.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m169_dose.ts --corpus m168
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m169_dose.ts --corpus broad100a
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m169_dose.ts --corpus broad100b
 *
 * Spawns the product's own `mcp-serve` over stdio and calls `run_pipeline`, once
 * per budget, in ONE session per case (§26: same task, same index, same
 * retrieval population, same ranking, same component routing — only
 * `capsule_budget_tokens` moves). No hand-crafted truncation exists anywhere in
 * this file; every reduction is whatever the shipped packer decided to do.
 *
 * Offline. No agent, no Docker, no network, no paid API, no writes into any
 * index or workspace.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

import { ResponseCategory, decompose } from "./m166Taxonomy";
import {
  BUDGET_LADDER,
  DEFAULT_RUNG,
  RUNG_LADDER,
  RemovedMaterialClass,
  RetentionClass,
  classifyRemovedMaterial,
  classifyRetention,
  readSurface,
  type DeliverySurface,
} from "./m169Dose";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const WORKSPACES = path.join(RESULTS, "workspaces");
const RUNS = path.join(RESULTS, "runs");

interface Case { readonly instanceId: string; readonly repoRoot: string; readonly task: string }

// ── corpora ─────────────────────────────────────────────────────────

/**
 * The twelve M168 tasks, replayed against the SAME workspaces the live agent
 * saw, with the SAME task string the live agent composed. Using the live
 * `task` argument rather than the raw problem statement is what makes the
 * reference rung a reproduction rather than a lookalike.
 */
function m168Cases(): Case[] {
  const cases: Case[] = [];
  for (const label of readdirSync(RUNS).filter((l) => l.startsWith("m168_vtrace_clean_")).sort()) {
    const outer = path.join(WORKSPACES, label);
    if (!existsSync(outer)) continue;
    const inner = readdirSync(outer).filter((e) => statSync(path.join(outer, e)).isDirectory());
    if (inner.length === 0) continue;
    const repoRoot = path.join(outer, inner[0]!);
    const stream = path.join(RUNS, label, "raw", "vtrace", "_agent_stream.first_pass.jsonl");
    if (!existsSync(stream)) continue;
    let task: string | null = null;
    for (const line of readFileSync(stream, "utf-8").split("\n")) {
      if (task !== null || line.trim() === "") continue;
      let row: Record<string, any>;
      try { row = JSON.parse(line) as Record<string, any>; } catch { continue; }
      if (row.type !== "assistant") continue;
      for (const block of (row.message?.content ?? []) as Record<string, any>[]) {
        if (block.type === "tool_use" && String(block.name ?? "").includes("run_pipeline")) {
          task = String(block.input?.task ?? block.input?.query ?? "");
        }
      }
    }
    if (task === null || task === "") continue;
    cases.push({ instanceId: inner[0]!, repoRoot, task });
  }
  return cases;
}

/**
 * A frozen corpus, taken from its committed fixture — the task text and the case
 * set are the fixture's, never re-derived.
 *
 * `workspaceRoot` exists because Broad100-A's original workspaces under
 * `workspaces/cross_repo/` are `index_corrupt / index_unreadable` to the current
 * build: 93 of 100 answer `repo_not_ready`. They are rematerialised at the
 * current index generation under a NEW root rather than re-indexed in place, so
 * that nothing which cites the originals is disturbed.
 */
function fixtureCases(fixtureFile: string, workspaceRoot: string | null = null): Case[] {
  const rows = JSON.parse(readFileSync(path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke", fixtureFile), "utf-8")) as {
    instance_id: string; workspace: string; task: string;
  }[];
  return rows
    .map((row) => ({
      instanceId: row.instance_id,
      repoRoot: workspaceRoot === null ? path.join(ROOT, row.workspace) : path.join(workspaceRoot, row.instance_id),
      task: row.task,
    }))
    .filter((c) => existsSync(path.join(c.repoRoot, ".vtrace", "index.sqlite")));
}

// ── product invocation ──────────────────────────────────────────────

async function speak(repoRoot: string, messages: readonly unknown[]): Promise<Map<number, Record<string, any>>> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      ["src/cli/index.ts", "mcp-serve", "--repo", repoRoot, "--tools", "run_pipeline,get_impact_graph"],
      { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("mcp-serve timeout")); }, 600_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => {
      clearTimeout(timer);
      const byId = new Map<number, Record<string, any>>();
      for (const line of stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const row = JSON.parse(line) as Record<string, any>;
          if (typeof row.id === "number") byId.set(row.id, row);
        } catch { /* not a protocol frame */ }
      }
      resolve(byId);
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

/**
 * The channel the model was actually handed.
 *
 * The server returns two representations. `content[0].text` is the bare output
 * object; `structuredContent` is the same output inside the server's envelope.
 * The M168 transcripts show the ENVELOPE in the model's tool_result block, so
 * `structuredContent` is the delivered channel and the one that is measured.
 * M167 already priced the other copy at zero model tokens; reading the wrong one
 * here would have understated every payload by its envelope.
 */
function modelVisibleText(frame: Record<string, any> | undefined): string | null {
  const structured = frame?.result?.structuredContent;
  if (structured !== undefined && structured !== null) return JSON.stringify(structured);
  const content = frame?.result?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0] as Record<string, any>;
  return typeof first?.text === "string" ? first.text : null;
}

// ── per-case ladder ─────────────────────────────────────────────────

interface RungRow {
  readonly budget: number | string;
  readonly status: string;
  readonly deliveredCharacters: number;
  readonly modelVisibleContextCharacters: number;
  readonly evidenceCharacters: number | null;
  readonly controlCharacters: number | null;
  readonly duplicateCharacters: number | null;
  readonly transportCharacters: number | null;
  readonly diagnosticCharacters: number | null;
  readonly provenanceCharacters: number | null;
  readonly pivots: number;
  readonly support: number;
  readonly neighborhoodExcerpts: number;
  readonly withinEnvelope: boolean | null;
  readonly compactionApplied: boolean | null;
  readonly compactedFieldCount: number;
  readonly retention: RetentionClass | null;
  readonly lostPivotPaths: readonly string[];
  readonly lostSupportPaths: readonly string[];
  readonly lostTruthfulnessFields: readonly string[];
  readonly removedMaterial: Readonly<Record<string, number>>;
}

const REPEAT_CONTROL_ID = 900;

async function runLadder(testCase: Case): Promise<{ instanceId: string; rungs: RungRow[]; repeatControl: string; error: string | null }> {
  const messages: unknown[] = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m169", version: "1" } } },
  ];
  const argumentsFor = (rung: typeof RUNG_LADDER[number]): Record<string, unknown> =>
    rung === DEFAULT_RUNG
      ? { task: testCase.task, repo_root: testCase.repoRoot }
      : { task: testCase.task, repo_root: testCase.repoRoot, max_tokens: rung };
  RUNG_LADDER.forEach((rung, i) => {
    messages.push({
      jsonrpc: "2.0",
      id: 100 + i,
      method: "tools/call",
      params: { name: "run_pipeline", arguments: argumentsFor(rung) },
    });
  });
  // §70 identity control, LAST so it also proves the ladder left no residue:
  // the default call repeated after every rung must return the same delivery.
  messages.push({
    jsonrpc: "2.0",
    id: REPEAT_CONTROL_ID,
    method: "tools/call",
    params: { name: "run_pipeline", arguments: argumentsFor(DEFAULT_RUNG) },
  });

  let frames: Map<number, Record<string, any>>;
  try { frames = await speak(testCase.repoRoot, messages); }
  catch (error) { return { instanceId: testCase.instanceId, rungs: [], repeatControl: "ERROR", error: String(error) }; }

  const surfaces = new Map<string, DeliverySurface>();
  const texts = new Map<string, string>();
  for (const [i, rung] of RUNG_LADDER.entries()) {
    const text = modelVisibleText(frames.get(100 + i));
    if (text === null) continue;
    texts.set(String(rung), text);
    surfaces.set(String(rung), readSurface(text));
  }

  const reference = surfaces.get(String(DEFAULT_RUNG)) ?? null;
  const repeatText = modelVisibleText(frames.get(REPEAT_CONTROL_ID));
  const repeatSurface = repeatText === null ? null : readSurface(repeatText);
  const repeatControl = reference === null || repeatSurface === null
    ? "NOT_OBSERVED"
    // A control that certifies two identical ERRORS as an identical delivery cannot
    // discriminate the case it exists to check. Non-delivery is NOT_COMPARABLE.
    : reference.parseStatus !== "PARSED" || repeatSurface.parseStatus !== "PARSED"
      ? "NOT_COMPARABLE"
      : sameDelivery(reference, repeatSurface) ? "IDENTICAL_DELIVERY" : "DIVERGED";

  const rungs: RungRow[] = RUNG_LADDER.map((rungValue) => {
    const budget = rungValue as number | string;
    const surface = surfaces.get(String(budget));
    if (surface === undefined) {
      return {
        budget, status: "NO_RESPONSE", deliveredCharacters: 0, modelVisibleContextCharacters: 0,
        evidenceCharacters: null, controlCharacters: null, duplicateCharacters: null, transportCharacters: null,
        diagnosticCharacters: null, provenanceCharacters: null, pivots: 0, support: 0, neighborhoodExcerpts: 0,
        withinEnvelope: null, compactionApplied: null, compactedFieldCount: 0,
        retention: null, lostPivotPaths: [], lostSupportPaths: [], lostTruthfulnessFields: [], removedMaterial: {},
      };
    }
    let categories: Record<string, number> | null = null;
    if (surface.parseStatus === "PARSED") {
      try {
        const output = (JSON.parse(texts.get(String(budget))!) as Record<string, any>).result.output;
        categories = decompose(output).byCategory as unknown as Record<string, number>;
      } catch { categories = null; }
    }
    const verdict = reference === null ? null : classifyRetention(reference, surface);
    const removed: Record<string, number> = {};
    if (verdict !== null) {
      const survivingText = texts.get(String(budget)) ?? "";
      for (const lost of verdict.lostPivotPaths) {
        const cls = classifyRemovedMaterial(lost, true, survivingText);
        removed[cls] = (removed[cls] ?? 0) + 1;
      }
      for (const lost of verdict.lostSupportPaths) {
        const cls = classifyRemovedMaterial(lost, false, survivingText);
        removed[cls] = (removed[cls] ?? 0) + 1;
      }
    }
    return {
      budget,
      status: surface.parseStatus,
      deliveredCharacters: surface.serializedCharacters,
      modelVisibleContextCharacters: surface.modelVisibleContextCharacters,
      evidenceCharacters: categories?.[ResponseCategory.RepositoryEvidence] ?? null,
      controlCharacters: categories?.[ResponseCategory.AgentUsefulControl] ?? null,
      duplicateCharacters: categories?.[ResponseCategory.Duplicate] ?? null,
      transportCharacters: categories?.[ResponseCategory.TransportStructure] ?? null,
      diagnosticCharacters: categories?.[ResponseCategory.MachineDiagnostic] ?? null,
      provenanceCharacters: categories?.[ResponseCategory.Provenance] ?? null,
      pivots: surface.pivotPaths.length,
      support: surface.supportPaths.length,
      neighborhoodExcerpts: surface.pivotNeighborhoodExcerpts,
      withinEnvelope: surface.withinEnvelope,
      compactionApplied: surface.compactionApplied,
      compactedFieldCount: surface.compactedFields.length,
      retention: verdict?.retention ?? null,
      lostPivotPaths: verdict?.lostPivotPaths ?? [],
      lostSupportPaths: verdict?.lostSupportPaths ?? [],
      lostTruthfulnessFields: verdict?.lostTruthfulnessFields ?? [],
      removedMaterial: removed,
    };
  });

  return { instanceId: testCase.instanceId, rungs, repeatControl, error: null };
}

/** Same delivered evidence and same truthfulness surface; clocks are allowed to differ. */
function sameDelivery(left: DeliverySurface, right: DeliverySurface): boolean {
  return left.parseStatus === right.parseStatus
    && left.leadPivot === right.leadPivot
    && left.itemFqNames.join("|") === right.itemFqNames.join("|")
    && left.modelVisibleContextCharacters === right.modelVisibleContextCharacters
    && JSON.stringify(left.truthfulness) === JSON.stringify(right.truthfulness);
}

// ── main ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const corpus = argv[argv.indexOf("--corpus") + 1] ?? "m168";
const limitArg = argv.indexOf("--limit");
const limit = limitArg >= 0 ? Number(argv[limitArg + 1]) : null;
const concurrencyArg = argv.indexOf("--concurrency");
const concurrency = concurrencyArg >= 0 ? Number(argv[concurrencyArg + 1]) : 4;

const CORPORA: Record<string, () => Case[]> = {
  m168: m168Cases,
  broad100a: () => fixtureCases("retrieval_eval.m155_broad_100.json", path.join(WORKSPACES, "m169_broad_a")),
  broad100a_original: () => fixtureCases("retrieval_eval.m155_broad_100.json"),
  broad100b: () => fixtureCases("retrieval_eval.m160_broad_b.json"),
};

const loader = CORPORA[corpus];
if (loader === undefined) throw new Error(`unknown corpus ${corpus}; expected one of ${Object.keys(CORPORA).join(", ")}`);
const allCases = loader();
const cases = limit === null ? allCases : allCases.slice(0, limit);
console.log(`corpus ${corpus}: ${cases.length} case(s) with an index present (of ${allCases.length} discovered)`);

const results: Awaited<ReturnType<typeof runLadder>>[] = [];
let cursor = 0;
let done = 0;
await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, cases.length)) }, async () => {
  for (;;) {
    const index = cursor;
    cursor += 1;
    const testCase = cases[index];
    if (testCase === undefined) return;
    const result = await runLadder(testCase);
    results.push(result);
    done += 1;
    const reference = result.rungs.find((r) => r.budget === DEFAULT_RUNG);
    console.log(`[${done}/${cases.length}] ${testCase.instanceId} ref=${reference?.deliveredCharacters ?? "?"}ch `
      + `${result.rungs.map((r) => `${r.budget}:${r.deliveredCharacters}`).join(" ")}${result.error ? ` ERROR ${result.error}` : ""}`);
  }
}));

results.sort((a, b) => a.instanceId.localeCompare(b.instanceId));

const quantile = (values: readonly number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]!;
};
const median = (values: readonly number[]): number => quantile(values, 0.5);

const perBudget = RUNG_LADDER.map((rung) => {
  const budget = rung as number | string;
  const rungs = results.map((r) => r.rungs.find((x) => x.budget === budget)).filter((r): r is RungRow => r !== undefined);
  const parsed = rungs.filter((r) => r.status === "PARSED");
  const comparable = parsed.filter((r) => r.retention !== null && r.retention !== RetentionClass.NotComparable);
  const counts: Record<string, number> = {};
  for (const rung of comparable) counts[rung.retention!] = (counts[rung.retention!] ?? 0) + 1;
  const removed: Record<string, number> = {};
  for (const rung of comparable) {
    for (const [cls, n] of Object.entries(rung.removedMaterial)) removed[cls] = (removed[cls] ?? 0) + n;
  }
  const chars = parsed.map((r) => r.deliveredCharacters);
  return {
    budget,
    cases: rungs.length,
    parsed: parsed.length,
    comparable: comparable.length,
    medianDeliveredCharacters: median(chars),
    p90DeliveredCharacters: quantile(chars, 0.9),
    medianEvidenceCharacters: median(parsed.map((r) => r.evidenceCharacters ?? 0)),
    medianControlCharacters: median(parsed.map((r) => r.controlCharacters ?? 0)),
    medianTransportCharacters: median(parsed.map((r) => r.transportCharacters ?? 0)),
    medianDuplicateCharacters: median(parsed.map((r) => r.duplicateCharacters ?? 0)),
    medianModelVisibleContextCharacters: median(parsed.map((r) => r.modelVisibleContextCharacters)),
    retention: counts,
    primaryPreservedPercent: comparable.length === 0 ? null : Number(((100 * comparable.filter(
      (r) => r.retention === RetentionClass.Equivalent || r.retention === RetentionClass.PrimaryPreserved
        || r.retention === RetentionClass.SupportLoss,
    ).length) / comparable.length).toFixed(1)),
    truthfulnessPreservedPercent: comparable.length === 0 ? null : Number(((100 * comparable.filter(
      (r) => r.retention !== RetentionClass.TruthfulnessLoss,
    ).length) / comparable.length).toFixed(1)),
    supportPreservedPercent: comparable.length === 0 ? null : Number(((100 * comparable.filter(
      (r) => r.lostSupportPaths.length === 0,
    ).length) / comparable.length).toFixed(1)),
    compactionAppliedCases: parsed.filter((r) => r.compactionApplied === true).length,
    withinEnvelopeCases: parsed.filter((r) => r.withinEnvelope === true).length,
    removedMaterial: removed,
  };
});

const document = {
  schemaVersion: "stage5.m169.dose-simulation.v1",
  milestone: "M169",
  workstream: "M169-D",
  corpus,
  ladder: RUNG_LADDER,
  referenceRung: DEFAULT_RUNG,
  knob: "max_tokens — the argument the tool schema documents as the caller's model-visible context budget",
  knobCorrection: "The plan named capsule_budget_tokens. An identity control rejected it: at 8000 it also raises the v1 capsule character budget from its own default of 2000 to 32000, so it cannot reproduce the default call. Recorded rather than silently swapped.",
  repeatControl: {
    definition: "the no-argument call, repeated after every rung, must return the same delivered evidence and truthfulness surface",
    identical: results.filter((r) => r.repeatControl === "IDENTICAL_DELIVERY").length,
    diverged: results.filter((r) => r.repeatControl === "DIVERGED").length,
    notObserved: results.filter((r) => r.repeatControl === "NOT_OBSERVED").length,
    notComparable: results.filter((r) => r.repeatControl === "NOT_COMPARABLE").length,
  },
  ladderProvenance: "frozen in stage5_m169_plan.md before any dose result existed (§24)",
  invariants: [
    "same task string, same index, same retrieval population, same ranking, same component routing",
    "only capsule_budget_tokens differs between rungs",
    "no hand-crafted truncation: every reduction is the shipped packer's own decision",
  ],
  casesDiscovered: allCases.length,
  casesRun: cases.length,
  perBudget,
  perCase: results,
};

const out = `stage5_m169_dose_simulation_${corpus}.json`;
writeFileSync(path.join(RESULTS, out), `${JSON.stringify(document, null, 2)}\n`);
console.log(`\nwrote ${out}`);
for (const row of perBudget) {
  console.log(`  ${String(row.budget).padStart(7)}  median ${String(row.medianDeliveredCharacters).padStart(6)}ch  `
    + `evidence ${String(row.medianEvidenceCharacters).padStart(5)}  mvc ${String(row.medianModelVisibleContextCharacters).padStart(5)}  `
    + `primary ${String(row.primaryPreservedPercent).padStart(5)}%  truth ${String(row.truthfulnessPreservedPercent).padStart(5)}%  `
    + `${JSON.stringify(row.retention)}`);
}
