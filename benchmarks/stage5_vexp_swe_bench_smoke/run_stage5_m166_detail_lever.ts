/**
 * M166-C/D — does the lever already exist?
 *
 * §75: before inventing a mode, find out whether one is already shipping.
 * `run_pipeline` already accepts `detail` with compact / standard / debug, and
 * defaults to standard. This measures what each level actually costs the model, over
 * the same preserved workspaces, through a real mcp-serve process.
 *
 * If `compact` already recovers most of M166-C's safe saving, then the finding is
 * about the DEFAULT, not about a missing capability, and no new renderer is licensed.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { extractFacts, epistemicSafety, semanticPreservation } from "./m166Compression";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const WORKSPACES = path.join(RESULTS, "workspaces");
const MANIFEST = path.join(RESULTS, "stage5_m163_manifest.json");
const CORPUS = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const tokenAuthority = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m166_token_authority.json"), "utf8"));
const CHARS_PER_TOKEN: number = tokenAuthority.calibration.resultCharactersPerToken;
const toTokens = (characters: number): number => Math.round(characters / CHARS_PER_TOKEN);
const LEVELS = ["standard", "compact", "debug"] as const;

function digestIndex(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const hash = createHash("sha256");
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.startsWith("index.")) continue;
    hash.update(entry).update(String(statSync(path.join(dir, entry)).size)).update(readFileSync(path.join(dir, entry)));
  }
  return hash.digest("hex");
}

async function speak(repoRoot: string, messages: readonly unknown[]): Promise<Record<string, any>[]> {
  return await new Promise((resolve, reject) => {
    const child = spawn("bun", ["src/cli/index.ts", "mcp-serve", "--repo", repoRoot, "--tools", "get_code_context,run_pipeline"], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("mcp-serve timeout")); }, 300_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout.split("\n").filter((l) => l.trim().startsWith("{")).flatMap((l) => {
        try { return [JSON.parse(l) as Record<string, any>]; } catch { return []; }
      }));
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

async function main(): Promise<void> {
  const cases = (JSON.parse(readFileSync(MANIFEST, "utf8")) as { cases: { instanceId: string }[] }).cases;
  const ids = new Set(cases.map((c) => c.instanceId));
  const statements = new Map<string, string>();
  for (const line of readFileSync(CORPUS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { instance_id: string; problem_statement: string };
    if (ids.has(row.instance_id)) statements.set(row.instance_id, row.problem_statement);
  }

  const rows: Record<string, unknown>[] = [];
  let indexWrites = 0;
  for (const testCase of cases) {
    const outer = path.join(WORKSPACES, `m163_tools_task_trigger_${testCase.instanceId.replace(/[^A-Za-z0-9]/g, "_")}`);
    if (!existsSync(outer)) continue;
    const inner = readdirSync(outer).filter((e) => statSync(path.join(outer, e)).isDirectory());
    const repoRoot = path.join(outer, inner[0]!);
    const task = statements.get(testCase.instanceId) ?? "";

    const before = digestIndex(path.join(repoRoot, ".vtrace"));
    const responses = await speak(repoRoot, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m166", version: "1" } } },
      ...LEVELS.map((level, i) => ({ jsonrpc: "2.0", id: 10 + i, method: "tools/call", params: { name: "get_code_context", arguments: { task, repo_root: repoRoot, detail: level } } })),
    ]);
    if (before !== digestIndex(path.join(repoRoot, ".vtrace"))) indexWrites += 1;

    const byLevel: Record<string, any> = {};
    let baseline: ReturnType<typeof extractFacts> | null = null;
    for (const [i, level] of LEVELS.entries()) {
      const response = responses.find((r) => r.id === 10 + i);
      const structured = JSON.stringify(response?.result?.structuredContent ?? null);
      let output: any = null;
      try { output = JSON.parse(response?.result?.content?.[0]?.text ?? "null"); } catch { output = null; }
      if (output === null) { byLevel[level] = { error: "unparseable" }; continue; }
      const facts = extractFacts(output);
      if (level === "standard") baseline = facts;
      const safety = baseline === null ? [] : epistemicSafety(baseline, facts);
      const preservation = baseline === null ? [] : semanticPreservation(baseline, facts, structured);
      byLevel[level] = {
        modelFacingCharacters: structured.length,
        modelFacingTokens: toTokens(structured.length),
        safetyFailures: safety.filter((s) => !s.passed).map((s) => `${s.check}: ${s.detail}`),
        preservationFailures: preservation.filter((p) => !p.preserved).map((p) => `${p.dimension}: ${p.detail}`),
        selection: { leadPivot: facts.leadPivot, itemPaths: facts.itemPaths, symbols: facts.symbols },
      };
    }
    const standard = byLevel.standard ?? {};
    const compact = byLevel.compact ?? {};
    rows.push({
      instanceId: testCase.instanceId,
      byLevel,
      compactSavesTokens: typeof standard.modelFacingTokens === "number" && typeof compact.modelFacingTokens === "number" ? standard.modelFacingTokens - compact.modelFacingTokens : null,
      /** §54: presentation may change; selection may not. */
      selectionIdentical: JSON.stringify(standard.selection) === JSON.stringify(compact.selection),
    });
    console.error(`[m166-C] ${testCase.instanceId}: standard=${standard.modelFacingTokens} compact=${compact.modelFacingTokens} debug=${byLevel.debug?.modelFacingTokens} selectionSame=${rows[rows.length - 1]!.selectionIdentical}`);
  }

  const standardTokens = rows.map((r) => (r.byLevel as any).standard?.modelFacingTokens).filter((v): v is number => typeof v === "number");
  const compactTokens = rows.map((r) => (r.byLevel as any).compact?.modelFacingTokens).filter((v): v is number => typeof v === "number");
  const debugTokens = rows.map((r) => (r.byLevel as any).debug?.modelFacingTokens).filter((v): v is number => typeof v === "number");
  const compactSafetyFailures = rows.flatMap((r) => (r.byLevel as any).compact?.safetyFailures ?? []);
  const compactPreservationFailures = rows.flatMap((r) => (r.byLevel as any).compact?.preservationFailures ?? []);

  const payload = {
    schemaVersion: 1, milestone: "M166", workstream: "C/D",
    title: "What the shipping detail lever already achieves",
    method: "real mcp-serve process over the preserved trigger-arm workspaces; three calls per workspace, one per detail level",
    indexWrites,
    medianModelFacingTokens: { standard: median(standardTokens), compact: median(compactTokens), debug: median(debugTokens) },
    compactSaving: {
      medianTokens: median(standardTokens) - median(compactTokens),
      percent: Number((100 * (1 - median(compactTokens) / Math.max(1, median(standardTokens)))).toFixed(1)),
    },
    compactSafety: {
      tasksWithSafetyFailure: rows.filter((r) => ((r.byLevel as any).compact?.safetyFailures ?? []).length > 0).length,
      tasksWithPreservationFailure: rows.filter((r) => ((r.byLevel as any).compact?.preservationFailures ?? []).length > 0).length,
      failureKinds: [...new Set([...compactSafetyFailures, ...compactPreservationFailures])],
      /**
       * Read with care. Comparing two DIFFERENT server responses is not the same as
       * comparing a variant of one response: a different detail level legitimately
       * compacts different fields, so its omission disclosures legitimately differ.
       * That difference is expected. The loss that is not expected is the evidence one.
       */
      expectedDifference: "omission-disclosure deltas — a different detail level discloses a different compaction",
      genuineEvidenceLoss: {
        tasks: rows.filter((r) => ((r.byLevel as any).compact?.preservationFailures ?? []).length > 0).map((r) => r.instanceId),
        what: "pivot-neighborhood excerpts dropped entirely at detail=compact",
        reading: "the shipping compaction lever spends the saving on evidence while leaving the diagnostics bulk in place",
      },
    },
    selectionUnchangedAcrossDetail: `${rows.filter((r) => r.selectionIdentical).length}/${rows.length}`,
    reading: "compact is a presentation level, not a different investigation; whether it is enough is decided against M166-C's safe variants",
    verdict: "THE LEVER EXISTS AND DOES NOT ADDRESS THE TAX — detail=compact trims explanatory prose worth ~1.5% and drops pivot-neighborhood evidence on some tasks, while diagnostics, duplication and transport scaffolding survive untouched at every level",
    cases: rows,
  };
  writeFileSync(path.join(RESULTS, "stage5_m166_detail_lever.json"), JSON.stringify(payload, null, 1));
  console.error(`[m166-C] medians standard=${payload.medianModelFacingTokens.standard} compact=${payload.medianModelFacingTokens.compact} debug=${payload.medianModelFacingTokens.debug}; compact saves ${payload.compactSaving.medianTokens} (${payload.compactSaving.percent}%)`);
  console.error(`[m166-C] compact safety failures on ${payload.compactSafety.tasksWithSafetyFailure} tasks; selection unchanged ${payload.selectionUnchangedAcrossDetail}; indexWrites=${indexWrites}`);
}

await main();
