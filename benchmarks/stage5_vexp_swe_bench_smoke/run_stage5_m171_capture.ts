/**
 * M171-A — capture what the model is actually handed, on fresh indexes.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m171_capture.ts --corpus dev
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m171_capture.ts --corpus broad100a
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m171_capture.ts --corpus broad100b
 *
 * One `mcp-serve` per case; `run_pipeline` at the DEFAULT detail and again at
 * `detail=debug`, so that A can distinguish "the model sees this" from "VTRACE
 * knows this". §21: the measured channel is `structuredContent`, the one M167
 * proved the client consumes — never the pretty renderer and never wire bytes.
 *
 * Offline. No agent, no Docker, no paid API. Writes only under
 * `results/_m171_capture/` (untracked).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(".");
const BENCH = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke");
const RESULTS = path.join(BENCH, "results");
const WORKSPACES = path.join(RESULTS, "workspaces");
const CAPTURE = path.join(RESULTS, "_m171_capture");

const argv = process.argv.slice(2);
const corpus = argv[argv.indexOf("--corpus") + 1] ?? "dev";
const limitFlag = argv.indexOf("--limit");
const limit = limitFlag === -1 ? Number.POSITIVE_INFINITY : Number(argv[limitFlag + 1]);

/**
 * The twelve M168/M169 development cases (§30), and the two frozen holdouts.
 *
 * All three read their task text from the SAME frozen fixture field, so that a
 * dose curve measured on the development set and a dose curve measured on a
 * holdout are measuring the same kind of input. Both A and B are read at the
 * fresh roots M169 re-materialised (§33) — `workspaces/cross_repo` is not
 * current-build authority and is never touched.
 */
const DEVELOPMENT_CASES: readonly string[] = Object.freeze([
  "astropy__astropy-14369", "django__django-13658", "matplotlib__matplotlib-22719",
  "mwaskom__seaborn-3187", "pallets__flask-5014", "psf__requests-1724",
  "pydata__xarray-6599", "pylint-dev__pylint-4551", "pytest-dev__pytest-7432",
  "scikit-learn__scikit-learn-10844", "sphinx-doc__sphinx-7462", "sympy__sympy-13480",
]);

interface Corpus {
  readonly fixture: string;
  readonly workspaceRoot: string | null;
  readonly select: ((instanceId: string) => boolean) | null;
}

const CORPORA: Readonly<Record<string, Corpus>> = Object.freeze({
  dev: {
    fixture: "retrieval_eval.m155_broad_100.json",
    workspaceRoot: path.join(WORKSPACES, "m169_broad_a"),
    select: (instanceId) => DEVELOPMENT_CASES.includes(instanceId),
  },
  broad100a: {
    fixture: "retrieval_eval.m155_broad_100.json",
    workspaceRoot: path.join(WORKSPACES, "m169_broad_a"),
    select: null,
  },
  broad100b: {
    fixture: "retrieval_eval.m160_broad_b.json",
    workspaceRoot: null,
    select: null,
  },
});

const spec = CORPORA[corpus];
if (spec === undefined) throw new Error(`unknown corpus ${corpus}`);

interface Case {
  readonly instanceId: string;
  readonly repoRoot: string;
  readonly task: string;
  readonly expectedFiles: readonly string[];
  readonly expectedSymbols: readonly string[];
}

function loadCases(): Case[] {
  const rows = JSON.parse(readFileSync(path.join(BENCH, spec.fixture), "utf-8")) as {
    instance_id: string; workspace: string; task: string;
    expected_files?: string[]; expected_symbols?: string[];
  }[];
  return rows
    .filter((row) => spec.select === null || spec.select(row.instance_id))
    .map((row) => ({
      instanceId: row.instance_id,
      repoRoot: spec.workspaceRoot === null ? path.join(ROOT, row.workspace) : path.join(spec.workspaceRoot, row.instance_id),
      task: row.task,
      expectedFiles: Object.freeze(row.expected_files ?? []),
      expectedSymbols: Object.freeze(row.expected_symbols ?? []),
    }))
    .filter((testCase) => existsSync(path.join(testCase.repoRoot, ".vtrace", "index.sqlite")))
    .slice(0, limit);
}

/**
 * Read the fresh root's own revision, so the capture carries the four things
 * §33 requires rather than an assurance that they were fine.
 */
function workspaceRevision(repoRoot: string): string | null {
  const head = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf-8" });
  return head.status === 0 ? head.stdout.trim() : null;
}

async function speak(repoRoot: string, messages: readonly unknown[]): Promise<Map<number, Record<string, unknown>>> {
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
      const byId = new Map<number, Record<string, unknown>>();
      for (const line of stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          if (typeof row.id === "number") byId.set(row.id, row);
        } catch { /* not a protocol frame */ }
      }
      resolve(byId);
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

const CALL_DEFAULT = 100;
const CALL_DEBUG = 101;
/** §51/§53: the same default call, issued last, must return the same delivery. */
const CALL_REPEAT = 190;

async function captureCase(testCase: Case): Promise<Record<string, unknown>> {
  const call = (id: number, extra: Record<string, unknown>) => ({
    jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "run_pipeline", arguments: { task: testCase.task, repo_root: testCase.repoRoot, ...extra } },
  });
  const messages: unknown[] = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m171", version: "1" } } },
    call(CALL_DEFAULT, {}),
    call(CALL_DEBUG, { detail: "debug" }),
    call(CALL_REPEAT, {}),
  ];

  let frames: Map<number, Record<string, unknown>>;
  try { frames = await speak(testCase.repoRoot, messages); }
  catch (error) {
    return { instanceId: testCase.instanceId, error: String(error), default: null, debug: null, repeat: null };
  }

  const frameOf = (id: number): Record<string, unknown> | null => {
    const frame = frames.get(id);
    if (frame === undefined) return null;
    const result = (frame as { result?: Record<string, unknown> }).result;
    if (result === undefined) return null;
    return {
      structuredContent: result.structuredContent ?? null,
      contentTextCharacters: Array.isArray(result.content) && result.content.length > 0
        ? String((result.content[0] as { text?: unknown }).text ?? "").length
        : 0,
      isError: result.isError === true,
    };
  };

  return {
    instanceId: testCase.instanceId,
    repoRoot: testCase.repoRoot,
    task: testCase.task,
    expectedFiles: testCase.expectedFiles,
    expectedSymbols: testCase.expectedSymbols,
    workspaceRevision: workspaceRevision(testCase.repoRoot),
    error: null,
    default: frameOf(CALL_DEFAULT),
    debug: frameOf(CALL_DEBUG),
    repeat: frameOf(CALL_REPEAT),
  };
}

async function main(): Promise<void> {
  const cases = loadCases();
  const outDir = path.join(CAPTURE, corpus);
  mkdirSync(outDir, { recursive: true });
  const manifest: Record<string, unknown>[] = [];

  for (const [index, testCase] of cases.entries()) {
    const captured = await captureCase(testCase);
    writeFileSync(path.join(outDir, `${testCase.instanceId}.json`), JSON.stringify(captured));
    const defaultFrame = captured.default as { structuredContent?: unknown; contentTextCharacters?: number } | null;
    const characters = defaultFrame?.structuredContent === undefined || defaultFrame?.structuredContent === null
      ? 0 : JSON.stringify(defaultFrame.structuredContent).length;
    manifest.push({
      instanceId: testCase.instanceId,
      repoRoot: testCase.repoRoot,
      workspaceRevision: captured.workspaceRevision ?? null,
      captured: captured.error === null,
      defaultCharacters: characters,
      contentTextCharacters: defaultFrame?.contentTextCharacters ?? 0,
    });
    process.stdout.write(`[${index + 1}/${cases.length}] ${testCase.instanceId} ${characters} chars\n`);
  }

  writeFileSync(
    path.join(CAPTURE, `${corpus}.manifest.json`),
    JSON.stringify({
      schemaVersion: "stage5.m171.capture-manifest.v1",
      milestone: "M171",
      workstream: "M171-A",
      corpus,
      fixture: spec.fixture,
      workspaceRoot: spec.workspaceRoot,
      vtraceCommit: spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim(),
      cases: manifest,
    }, null, 1),
  );
  process.stdout.write(`captured ${manifest.length} into ${outDir}\n`);
}

await main();
