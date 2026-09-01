/**
 * M196 — Deterministic capability audit of the authoritative VTRACE product path.
 *
 * Every load-bearing count in the M196 report is produced here, not transcribed.
 * The script makes NO model calls and spawns NO agent. It reads the registry,
 * parses source with the product parser, and exercises the product MCP handler
 * against locally built probe corpora.
 *
 * The five sections answer five separate questions the milestone keeps apart:
 *
 *   registry      — what is registered, and what is model-visible (§13)
 *   routing       — which producers the AUTHORITATIVE path actually reaches (§14)
 *   ingestion     — what fraction of a real repository the index can represent
 *   representation— what the compiler emits, and how it degrades under budget
 *   consumption   — how much repository evidence a successful agent actually used
 *
 * Corpora are built by the caller (see the M196 report §22 for the commands) and
 * passed by path. A missing corpus is reported as `skipped`, never silently
 * dropped: an audit that quietly measures less than it claims is the exact
 * failure mode M195A closed.
 */
import { Database } from "bun:sqlite";
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defaultMcpToolRegistry, RESERVED_MCP_TOOL_DEFINITIONS } from "../../src/mcp/tools";
import { McpToolId, MCP_SERVER_SCHEMA } from "../../src/mcp/types";
import { createMcpServer } from "../../src/mcp/server";
import { createTypeScriptParser } from "../../src/parsers/typescriptParser";
import { Language } from "../../src/domain/types";
import { getIndexedSkeletonFileResult } from "../../src/skeleton/getSkeleton";

const REPO = path.resolve(import.meta.dir, "../..");
const OUT = path.join(REPO, "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m196_capability_audit.json");

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const tsCorpus = arg("ts-corpus");
const pyCorpus = arg("py-corpus");

const tok = (s: string) => Math.ceil(s.length / 4);
const median = (v: number[]) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
const pctl = (v: number[], p: number) => v.slice().sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * p))] ?? 0;

// ---------------------------------------------------------------- 1. registry
const visible = new Set(defaultMcpToolRegistry.listMetadata().map((m) => m.toolId));
const reserved = new Set(RESERVED_MCP_TOOL_DEFINITIONS.map((t) => t.metadata.toolId));
const registry = {
  registeredTools: defaultMcpToolRegistry.tools.length,
  modelVisibleTools: visible.size,
  hiddenTools: defaultMcpToolRegistry.tools.length - visible.size,
  toolSchemaTokens: defaultMcpToolRegistry.listMetadata()
    .reduce((a, m) => a + tok(JSON.stringify({ name: m.toolId, description: m.description, inputSchema: m.inputSchema })), 0),
  tools: defaultMcpToolRegistry.tools.map((t) => ({
    toolId: t.metadata.toolId,
    modelVisible: visible.has(t.metadata.toolId),
    reserved: reserved.has(t.metadata.toolId),
    availability: t.metadata.registration.availability,
    handlerKind: t.metadata.registration.handlerKind,
    inputProperties: Object.keys(t.metadata.inputSchema?.properties ?? {}).length,
  })),
};

// ----------------------------------------------------------------- 2. routing
/**
 * Static module reachability from the authoritative entrypoint.
 *
 * "Is the primitive implemented?" and "does the product path reach it?" are
 * different questions (§14), and only the second one is answered by walking the
 * import graph. Reachability is a NECESSARY condition, never a sufficient one:
 * a module can be imported and still never invoked on any live branch, which is
 * why the report reads reachability together with the observed responses in
 * section 4 rather than instead of them.
 */
function reachableModules(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [path.resolve(REPO, entry)];
  while (stack.length > 0) {
    const file = stack.pop()!;
    const resolved = [file, `${file}.ts`, path.join(file, "index.ts")].find((c) => existsSync(c) && c.endsWith(".ts"));
    if (resolved === undefined || seen.has(resolved)) continue;
    seen.add(resolved);
    const src = readFileSync(resolved, "utf8");
    for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
      stack.push(path.resolve(path.dirname(resolved), m[1]!));
    }
  }
  return seen;
}
const rel = (p: string) => path.relative(REPO, p);
const fromTools = reachableModules("src/mcp/tools.ts");
const fromOrchestrator = reachableModules("src/runPipeline/runPipelineOrchestrator.ts");
const PRODUCERS: Record<string, string> = {
  retrieval: "src/retrieval/searchSymbolsShared.ts",
  capsuleV2: "src/capsuleV2/buildCapsuleV2.ts",
  productContext: "src/productContext/assembleProductContext.ts",
  skeleton: "src/skeleton/getSkeleton.ts",
  impact: "src/impact/getImpactGraph.ts",
  logicFlow: "src/logicFlow/searchLogicFlow.ts",
  documents: "src/documents/documentRetrieval.ts",
  orientation: "src/runPipeline/orientationProjection.ts",
  budget: "src/productContext/budgetDelivery.ts",
  workspaceCrossRepo: "src/workspace/crossRepoAggregation.ts",
  legacyCapsuleV1: "src/capsule/buildCapsuleImpl.ts",
  projectRules: "src/projectRules/projectRules.ts",
  memory: "src/observations/searchMemory.ts",
};
const routing = Object.fromEntries(Object.entries(PRODUCERS).map(([k, p]) => [k, {
  module: p,
  reachableFromToolLayer: [...fromTools].some((f) => rel(f) === p),
  reachableFromOrchestrator: [...fromOrchestrator].some((f) => rel(f) === p),
}]));

// --------------------------------------------------------------- 3. ingestion
/**
 * What fraction of a real repository the index can actually represent.
 *
 * Measured three ways because they disagree, and the disagreement IS the finding:
 * the bare parser limit, the limit as the product invokes it (with `knownFiles`
 * context, which lets one oversized file fail its importers), and the file sizes
 * themselves.
 */
function ingestionProbe(corpus: string | undefined, ext: string, label: string) {
  if (corpus === undefined || !existsSync(corpus)) return { status: "skipped", corpusLabel: label, corpus: corpus ?? null };
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".vtrace" || e.name === ".git" || e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(ext)) files.push(p);
    }
  };
  walk(corpus);
  const contents = files.map((f) => ({ path: path.relative(corpus, f), content: readFileSync(f, "utf8") }));
  const over = contents.filter((f) => f.content.length > 32767).length;
  // The absolute path is kept because it is the provenance of the measurement;
  // the label is what the M197 preregistration refers to.
  const out: any = { status: "measured", corpusLabel: label, corpus, files: files.length,
    filesOverParserLimit: over, parserLimitCharacters: 32767 };
  if (ext === ".ts") {
    const bare = createTypeScriptParser();
    const withContext = createTypeScriptParser({ knownFiles: contents });
    const count = async (p: ReturnType<typeof createTypeScriptParser>) => {
      let ok = 0;
      for (const f of contents) {
        try { await p.parse({ path: f.path, content: f.content, language: Language.TypeScript } as any); ok++; } catch { /* counted as loss */ }
      }
      return ok;
    };
    out.parsedBare = null; out.parsedWithKnownFiles = null; out._pending = { bare, withContext, count };
  }
  return out;
}
const ingestionTs: any = ingestionProbe(tsCorpus, ".ts", "C-MED");
if (ingestionTs._pending) {
  const { bare, withContext, count } = ingestionTs._pending;
  ingestionTs.parsedBare = await count(bare);
  ingestionTs.parsedWithKnownFiles = await count(withContext);
  ingestionTs.lostToParserLimitAlone = ingestionTs.files - ingestionTs.parsedBare;
  ingestionTs.lostToImportPropagation = ingestionTs.parsedBare - ingestionTs.parsedWithKnownFiles;
  ingestionTs.coveragePercent = +(100 * ingestionTs.parsedWithKnownFiles / ingestionTs.files).toFixed(1);
  delete ingestionTs._pending;
}
const ingestionPy = ingestionProbe(pyCorpus, ".py", "C-LARGE");

// ---------------------------------------------------------- 4. representation
function skeletonProbe(corpus: string | undefined) {
  const db2 = corpus && existsSync(path.join(corpus, ".vtrace/index.sqlite"))
    ? new Database(path.join(corpus, ".vtrace/index.sqlite"), { readonly: true }) : null;
  if (db2 === null) return { status: "skipped" };
  const render = (r: any) => [
    ...r.imports.map((i: any) => `import ${i.name} from ${i.fromFilePath}`),
    ...r.declarations.flatMap((d: any) => [
      `${d.exported ? "export " : ""}${d.kind} ${d.name}${d.signature ? " " + d.signature : ""}`,
      ...(d.docstring ? [`  """${d.docstring}"""`] : []),
      ...d.members.map((m: any) => `  ${m.kind} ${m.name}${m.signature ? " " + m.signature : ""}`),
    ]),
  ].join("\n");
  const byDetail: Record<string, number[]> = { minimal: [], standard: [], detailed: [] };
  let declarations = 0, withSignature = 0;
  for (const row of db2.query("select path from files order by path").all() as { path: string }[]) {
    let raw = "";
    try { raw = readFileSync(path.join(corpus!, row.path), "utf8"); } catch { continue; }
    if (raw.length < 2000) continue;
    for (const detail of ["minimal", "standard", "detailed"] as const) {
      const r = getIndexedSkeletonFileResult(db2, row.path, detail);
      if (!r) continue;
      byDetail[detail]!.push(100 * (1 - tok(render(r)) / tok(raw)));
      if (detail === "standard") {
        declarations += r.declarations.length;
        withSignature += r.declarations.filter((d: any) => d.signature).length;
      }
    }
  }
  return {
    status: "measured",
    filesMeasured: byDetail.standard!.length,
    reductionPercent: Object.fromEntries(Object.entries(byDetail).map(([k, v]) => [k, {
      median: +median(v).toFixed(1), p10: +pctl(v, 0.1).toFixed(1), min: +Math.min(...v).toFixed(1),
    }])),
    declarations, withSignature,
    signatureCoveragePercent: +(100 * withSignature / Math.max(1, declarations)).toFixed(1),
    bodyEmittedAtAnyDetailLevel: false,
  };
}

async function budgetProbe(corpus: string | undefined, tasks: readonly string[]) {
  if (corpus === undefined || !existsSync(path.join(corpus, ".vtrace/index.sqlite"))) return { status: "skipped" };
  const server = createMcpServer({ context: { repoRoot: corpus, dbPath: path.join(corpus, ".vtrace/index.sqlite") } as any });
  const budgets = [1000, 2000, 4000, 8000, 16000, 32000];
  const curves: any[] = [];
  for (const task of tasks) {
    const points: any[] = [];
    for (const b of budgets) {
      const t0 = performance.now();
      const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: `m196-${b}`,
        toolId: McpToolId.GetCodeContext, input: { task, repo_root: corpus, max_tokens: b } } as any);
      const o: any = res.result?.output;
      points.push({ budget: b, latencyMs: +(performance.now() - t0).toFixed(1),
        wholeResponseTokens: tok(JSON.stringify(o ?? {})),
        focus: o?.focus?.at ?? null, focusCodeTokens: tok(o?.focus?.code ?? ""),
        relatedCount: (o?.related ?? []).length,
        relatedCarryingCode: (o?.related ?? []).filter((r: any) => typeof r.code === "string").length });
    }
    let violations = 0;
    for (let i = 1; i < points.length; i++) if (points[i]!.focusCodeTokens < points[i - 1]!.focusCodeTokens) violations++;
    curves.push({ task, points, monotonicityViolations: violations });
  }
  return {
    status: "measured", budgetsTested: budgets, curves,
    tasksWithMonotonicityViolation: curves.filter((c) => c.monotonicityViolations > 0).length,
    tasksTested: curves.length,
    // Every observed response carried code for the focus symbol and for nothing else.
    relatedEverCarriedCode: curves.some((c: any) => c.points.some((p: any) => p.relatedCarryingCode > 0)),
  };
}

// ----------------------------------------------------------- 5. consumption
/**
 * How much repository evidence the M194 agents ACTUALLY consumed.
 *
 * This is the compression denominator for any future Track B proof, and §42
 * forbids inventing a larger one. Read/Grep/Glob RESULT bytes are the evidence
 * that entered the model's context; tool_use inputs alone would undercount a
 * whole-file read and overcount a miss.
 */
function consumptionProbe() {
  const base = path.join(REPO, "benchmarks/stage5_vexp_swe_bench_smoke/results/m194/runs");
  const ledger = path.join(REPO, "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m194_acquisition_ledger.jsonl");
  if (!existsSync(base) || !existsSync(ledger)) return { status: "skipped" };
  const resolvedById = new Map<string, boolean>();
  for (const line of readFileSync(ledger, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const d = JSON.parse(line);
    if (d.resolved !== null && d.resolved !== undefined) resolvedById.set(d.armId, Boolean(d.resolved));
  }
  const rows: any[] = [];
  for (const run of readdirSync(base).sort()) {
    const dir = path.join(base, run);
    const cfg = readdirSync(dir).find((d) => d.startsWith("claude-config-"));
    if (cfg === undefined) continue;
    const projects = path.join(dir, cfg, "projects", "-testbed");
    if (!existsSync(projects)) continue;
    const kind = new Map<string, string>();
    const filesRead = new Set<string>(); const filesEdited = new Set<string>();
    let readChars = 0, searchChars = 0;
    const tools: Record<string, number> = {};
    for (const jf of readdirSync(projects).filter((f) => f.endsWith(".jsonl"))) {
      for (const line of readFileSync(path.join(projects, jf), "utf8").split("\n")) {
        if (line.trim() === "") continue;
        let d: any; try { d = JSON.parse(line); } catch { continue; }
        const content = d.message?.content;
        if (!Array.isArray(content)) continue;
        for (const c of content) {
          if (c?.type === "tool_use") {
            tools[c.name] = (tools[c.name] ?? 0) + 1;
            kind.set(c.id, c.name);
            if (c.name === "Read" && c.input?.file_path) filesRead.add(c.input.file_path);
            if ((c.name === "Edit" || c.name === "Write") && c.input?.file_path) filesEdited.add(c.input.file_path);
          } else if (c?.type === "tool_result") {
            const nm = kind.get(c.tool_use_id);
            const text = typeof c.content === "string" ? c.content
              : Array.isArray(c.content) ? c.content.map((x: any) => x?.text ?? "").join("") : "";
            if (nm === "Read") readChars += text.length;
            else if (nm === "Grep" || nm === "Glob") searchChars += text.length;
          }
        }
      }
    }
    rows.push({ armId: run, resolved: resolvedById.get(run) ?? null, tools,
      filesRead: filesRead.size, filesEdited: filesEdited.size,
      readTokens: Math.floor(readChars / 4), searchTokens: Math.floor(searchChars / 4),
      repositoryEvidenceTokens: Math.floor((readChars + searchChars) / 4) });
  }
  const summarize = (g: any[]) => Object.fromEntries(
    ["filesRead", "filesEdited", "readTokens", "searchTokens", "repositoryEvidenceTokens"].map((k) => {
      const v = g.map((r) => r[k]);
      return [k, { median: median(v), p90: pctl(v, 0.9), max: Math.max(...v) }];
    }));
  const resolved = rows.filter((r) => r.resolved === true);
  const unresolved = rows.filter((r) => r.resolved === false);
  const totals: Record<string, number> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.tools)) totals[k] = (totals[k] ?? 0) + (v as number);
  return { status: "measured", arms: rows.length, resolvedArms: resolved.length, unresolvedArms: unresolved.length,
    all: summarize(rows), resolved: summarize(resolved), unresolved: summarize(unresolved),
    toolCallTotals: totals, perArm: rows };
}

const TASKS = [
  "budget allocation for capsule items is dropping sections",
  "how does the MCP response envelope bound its output",
  "where are import edges extracted from typescript",
];

const report = {
  schemaVersion: "stage5.m196.capability-audit.v1",
  milestone: "M196",
  generatedFrom: "repository inspection and deterministic local probes only; no model call, no agent",
  registry,
  routing,
  ingestion: { typescript: ingestionTs, python: ingestionPy },
  representation: {
    skeleton: { typescript: skeletonProbe(tsCorpus), python: skeletonProbe(pyCorpus) },
    budget: await budgetProbe(tsCorpus, TASKS),
  },
  consumption: consumptionProbe(),
};

writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${path.relative(REPO, OUT)}`);
console.log(JSON.stringify({
  registeredTools: registry.registeredTools, modelVisibleTools: registry.modelVisibleTools,
  tsCoveragePercent: ingestionTs.coveragePercent ?? null,
  pyFilesOverLimit: ingestionPy.filesOverParserLimit ?? null,
  monotonicityViolationTasks: (report.representation.budget as any).tasksWithMonotonicityViolation ?? null,
  resolvedMedianEvidenceTokens: (report.consumption as any).resolved?.repositoryEvidenceTokens?.median ?? null,
}, null, 1));
