/**
 * M213 §34 — VTRACE_TREATMENT_EXECUTABLE dry run.
 *
 * Proves, without a model and without a network fetch, that the VTRACE
 * treatment surface can actually be stood up on every repository the frozen
 * task population contains. One instance per repository, twelve repositories.
 *
 * For each repository this script:
 *
 *   1. materialises the instance's authoritative checkout from the cached
 *      SWE-bench eval image (`docker create` + `docker cp`, container removed
 *      immediately; no test runs, no network);
 *   2. checks the frozen `base_commit` out, the way the substrate does;
 *   3. records a digest of TRACKED source (`git ls-files -s`) BEFORE indexing;
 *   4. runs `vtrace index`;
 *   5. records the same digest AFTER, plus every path indexing created, so §14
 *      ("indexing must be observational") is measured rather than asserted;
 *   6. starts the product-default MCP server over stdio and issues
 *      `initialize` + `tools/list` + one `get_code_context` call, so tool-schema
 *      availability and a real deterministic query are both witnessed;
 *   7. deletes the checkout.
 *
 * NOTHING here is outcome-bearing: no agent, no gold patch, no FAIL_TO_PASS,
 * no evaluator. The task text handed to `get_code_context` is the instance's
 * own problem statement, which is what an agent would see anyway.
 *
 * Usage:
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m213_vtrace_executability.ts \
 *     --scratch <dir> [--out <results dir>]
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { M213_TASK_POPULATION_PATH, loadFrozenTaskPopulation } from "./m213Preregistration";

const execFile = promisify(execFileCallback);

const VTRACE_ROOT = path.resolve(import.meta.dir, "..", "..");
const DEFAULT_OUT = path.join(import.meta.dir, "results");

interface RepoProbe {
  readonly repo: string;
  readonly instanceId: string;
  readonly baseCommit: string;
  readonly imageKey: string;
  readonly imageCached: boolean;
  readonly checkoutOk: boolean;
  readonly headMatchesBaseCommit: boolean;
  readonly trackedDigestBefore: string | null;
  readonly trackedDigestAfter: string | null;
  readonly trackedSourceUnchanged: boolean;
  readonly workingTreeDirtyBefore: readonly string[];
  readonly pathsCreatedByIndexing: readonly string[];
  readonly indexOk: boolean;
  readonly indexDurationMs: number | null;
  readonly totalSymbols: number | null;
  readonly totalRelationships: number | null;
  readonly filesIndexed: number | null;
  readonly coverageComplete: boolean | null;
  readonly indexBytes: number | null;
  readonly toolsListOk: boolean;
  readonly visibleToolNames: readonly string[];
  readonly queryOk: boolean;
  readonly queryDurationMs: number | null;
  readonly queryItemCount: number | null;
  readonly queryOutputKeys: readonly string[];
  readonly error: string | null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `TestSpec.instance_image_key`, swebench 4.1.0, default namespace + tag. */
function instanceImageKey(instanceId: string): string {
  return `swebench/sweb.eval.x86_64.${instanceId.toLowerCase().replace("__", "_1776_")}:latest`;
}

async function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFile(command, [...args], {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 600_000,
      maxBuffer: 256 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (cause) {
    const error = cause as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message ?? "" };
  }
}

function directorySize(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  if (existsSync(root)) walk(root);
  return total;
}

/**
 * One stdio MCP session: `initialize`, `tools/list`, one `get_code_context`.
 *
 * No `--tools` flag, deliberately: the arm is defined as the PRODUCT-DEFAULT
 * surface, so the server must be started exactly the way a user's agent would
 * start it, and the catalogue read back rather than asserted.
 */
function mcpSession(
  repoRoot: string,
  task: string,
  timeoutMs = 900_000,
): Promise<{
  tools: string[]; queryOk: boolean; itemCount: number | null; outputKeys: string[];
  durationMs: number | null; error: string | null;
}> {
  const messages: unknown[] = [
    {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "m213-executability", version: "1" },
      },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "get_code_context", arguments: { task, repo_root: repoRoot } },
    },
  ];

  return new Promise<{
    tools: string[]; queryOk: boolean; itemCount: number | null; outputKeys: string[];
    durationMs: number | null; error: string | null;
  }>((resolve) => {
    const started = Date.now();
    const child = spawn(
      "bun",
      [path.join(VTRACE_ROOT, "src", "cli", "index.ts"), "mcp-serve", "--repo", repoRoot],
      { cwd: VTRACE_ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", () => { /* server logs are not the artifact */ });
    child.on("close", () => {
      clearTimeout(timer);
      let tools: string[] = [];
      let queryOk = false;
      let itemCount: number | null = null;
      let outputKeys: string[] = [];
      let error: string | null = null;
      for (const line of stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        let row: Record<string, unknown>;
        try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (row.id === 2) {
          const listed = (row.result as { tools?: { name?: string }[] } | undefined)?.tools ?? [];
          tools = listed.map((entry) => String(entry.name ?? "")).filter((name) => name.length > 0);
        }
        if (row.id === 3) {
          if (row.error !== undefined) {
            error = JSON.stringify(row.error);
            continue;
          }
          const structured = (row.result as {
            structuredContent?: Record<string, unknown>;
          } | undefined)?.structuredContent;
          const output = ((structured?.result as { output?: unknown } | undefined)?.output
            ?? structured?.output ?? structured) as Record<string, unknown> | undefined;
          if (output !== undefined && output !== null && typeof output === "object") {
            queryOk = true;
            outputKeys = Object.keys(output).sort();
            const related = output.related;
            const focus = output.focus;
            itemCount = (Array.isArray(related) ? related.length : 0)
              + (focus === undefined || focus === null ? 0 : 1);
          }
        }
      }
      resolve({ tools, queryOk, itemCount, outputKeys, durationMs: Date.now() - started, error });
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

function rootEntries(root: string): string[] {
  return readdirSync(root).sort();
}

async function probeRepository(
  scratch: string,
  instance: { instance_id: string; repo: string; base_commit: string; problem_statement: string },
): Promise<RepoProbe> {
  const imageKey = instanceImageKey(instance.instance_id);
  const checkout = path.join(scratch, instance.instance_id);
  const base = {
    repo: instance.repo,
    instanceId: instance.instance_id,
    baseCommit: instance.base_commit,
    imageKey,
  };

  const inspect = await run("docker", ["image", "inspect", imageKey], { timeoutMs: 120_000 });
  if (!inspect.ok) {
    return {
      ...base, imageCached: false, checkoutOk: false, headMatchesBaseCommit: false,
      trackedDigestBefore: null, trackedDigestAfter: null, trackedSourceUnchanged: false,
      workingTreeDirtyBefore: [], pathsCreatedByIndexing: [], indexOk: false,
      indexDurationMs: null, totalSymbols: null, totalRelationships: null, filesIndexed: null,
      coverageComplete: null, indexBytes: null, toolsListOk: false, visibleToolNames: [],
      queryOk: false, queryDurationMs: null, queryItemCount: null,
      queryOutputKeys: [],
      error: "image_not_cached",
    };
  }

  rmSync(checkout, { recursive: true, force: true });
  mkdirSync(path.dirname(checkout), { recursive: true });

  const create = await run("docker", ["create", imageKey, "sleep", "1"], { timeoutMs: 300_000 });
  if (!create.ok) {
    return {
      ...base, imageCached: true, checkoutOk: false, headMatchesBaseCommit: false,
      trackedDigestBefore: null, trackedDigestAfter: null, trackedSourceUnchanged: false,
      workingTreeDirtyBefore: [], pathsCreatedByIndexing: [], indexOk: false,
      indexDurationMs: null, totalSymbols: null, totalRelationships: null, filesIndexed: null,
      coverageComplete: null, indexBytes: null, toolsListOk: false, visibleToolNames: [],
      queryOk: false, queryDurationMs: null, queryItemCount: null,
      queryOutputKeys: [],
      error: `docker_create_failed: ${create.stderr.slice(0, 200)}`,
    };
  }
  const containerId = create.stdout.trim();
  const copy = await run("docker", ["cp", `${containerId}:/testbed`, checkout], { timeoutMs: 900_000 });
  await run("docker", ["rm", "-f", containerId], { timeoutMs: 120_000 });

  if (!copy.ok || !existsSync(checkout)) {
    rmSync(checkout, { recursive: true, force: true });
    return {
      ...base, imageCached: true, checkoutOk: false, headMatchesBaseCommit: false,
      trackedDigestBefore: null, trackedDigestAfter: null, trackedSourceUnchanged: false,
      workingTreeDirtyBefore: [], pathsCreatedByIndexing: [], indexOk: false,
      indexDurationMs: null, totalSymbols: null, totalRelationships: null, filesIndexed: null,
      coverageComplete: null, indexBytes: null, toolsListOk: false, visibleToolNames: [],
      queryOk: false, queryDurationMs: null, queryItemCount: null,
      queryOutputKeys: [],
      error: `docker_cp_failed: ${copy.stderr.slice(0, 200)}`,
    };
  }

  try {
    await run("git", ["checkout", "-f", "-q", instance.base_commit], { cwd: checkout, timeoutMs: 300_000 });
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const dirtyBefore = (await run("git", ["status", "--porcelain"], { cwd: checkout })).stdout
      .split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    const before = (await run("git", ["ls-files", "-s"], { cwd: checkout, timeoutMs: 300_000 })).stdout;
    const entriesBefore = new Set(rootEntries(checkout));

    const summaryFile = `${checkout}.index.json`;
    const indexStart = Date.now();
    const indexed = await run(
      "bash",
      [
        "-c",
        `bun ${JSON.stringify(path.join(VTRACE_ROOT, "src", "cli", "index.ts"))} index `
        + `${JSON.stringify(checkout)} --json --quiet > ${JSON.stringify(summaryFile)}`,
      ],
      { cwd: VTRACE_ROOT, timeoutMs: 1_800_000 },
    );
    const indexDurationMs = Date.now() - indexStart;

    let totalSymbols: number | null = null;
    let totalRelationships: number | null = null;
    let filesIndexed: number | null = null;
    let coverageComplete: boolean | null = null;
    let summaryParseError: string | null = null;
    if (indexed.ok) {
      try {
        const written = readFileSync(summaryFile, "utf8");
        const brace = written.indexOf("{");
        if (brace < 0) throw new Error("no JSON object in index summary");
        const summary = JSON.parse(written.slice(brace)) as {
          totalSymbols?: number;
          totalRelationships?: number;
          coverage?: { filesIndexed?: number; complete?: boolean };
        };
        totalSymbols = summary.totalSymbols ?? null;
        totalRelationships = summary.totalRelationships ?? null;
        filesIndexed = summary.coverage?.filesIndexed ?? null;
        coverageComplete = summary.coverage?.complete ?? null;
      } catch (cause) {
        // Reported, never guessed: a null count must be distinguishable from a
        // repository that genuinely has none.
        summaryParseError = cause instanceof Error ? cause.message : String(cause);
      }
    }

    const after = (await run("git", ["ls-files", "-s"], { cwd: checkout, timeoutMs: 300_000 })).stdout;
    const created = rootEntries(checkout).filter((entry) => !entriesBefore.has(entry));

    const session = await mcpSession(checkout, instance.problem_statement.slice(0, 4000));

    return {
      ...base,
      imageCached: true,
      checkoutOk: true,
      headMatchesBaseCommit: head === instance.base_commit,
      trackedDigestBefore: sha256(before),
      trackedDigestAfter: sha256(after),
      trackedSourceUnchanged: sha256(before) === sha256(after),
      workingTreeDirtyBefore: dirtyBefore,
      pathsCreatedByIndexing: created,
      indexOk: indexed.ok,
      indexDurationMs,
      totalSymbols,
      totalRelationships,
      filesIndexed,
      coverageComplete,
      indexBytes: directorySize(path.join(checkout, ".vtrace")),
      toolsListOk: session.tools.length > 0,
      visibleToolNames: session.tools,
      queryOk: session.queryOk,
      queryDurationMs: session.durationMs,
      queryItemCount: session.itemCount,
      queryOutputKeys: session.outputKeys,
      error: indexed.ok
        ? [session.error, summaryParseError === null ? null : `summary_parse: ${summaryParseError}`]
          .filter((entry) => entry !== null).join("; ") || null
        : `index_failed: ${indexed.stderr.slice(0, 300)}`,
    };
  } finally {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(`${checkout}.index.json`, { force: true });
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const readFlag = (name: string, fallback: string): string => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] !== undefined ? String(argv[at + 1]) : fallback;
  };
  const scratch = readFlag("--scratch", path.join("/tmp", "m213-exec"));
  const outDir = readFlag("--out", DEFAULT_OUT);
  mkdirSync(scratch, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const population = loadFrozenTaskPopulation();
  const raw = readFileSync(M213_TASK_POPULATION_PATH, "utf8").trim().split("\n").map((line) =>
    JSON.parse(line) as { instance_id: string; repo: string; base_commit: string; problem_statement: string });
  const byId = new Map(raw.map((row) => [row.instance_id, row] as const));

  // Deterministic, outcome-blind selection: within each repository, the
  // lexicographically first frozen instance whose eval image is already cached
  // on this host. Image availability is an infrastructure constraint and is
  // recorded as one; nothing about gold patches, difficulty or history is read.
  const cached = new Set(
    (await run("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"], { timeoutMs: 120_000 }))
      .stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0),
  );

  const selected: { instance_id: string; repo: string; base_commit: string; problem_statement: string }[] = [];
  const uncoveredRepositories: string[] = [];
  for (const repo of population.repositories) {
    const candidates = population.instanceIds
      .filter((id) => byId.get(id)?.repo === repo)
      .sort();
    const withImage = candidates.find((id) => cached.has(instanceImageKey(id)));
    if (withImage === undefined) {
      uncoveredRepositories.push(repo);
      continue;
    }
    selected.push(byId.get(withImage)!);
  }

  const probes: RepoProbe[] = [];
  for (const instance of selected) {
    process.stderr.write(`[m213] probing ${instance.instance_id}\n`);
    probes.push(await probeRepository(scratch, instance));
  }

  const repositoriesProven = probes.filter((probe) =>
    probe.checkoutOk && probe.indexOk && probe.toolsListOk && probe.queryOk).length;

  const artifact = {
    schemaVersion: "stage5.m213.vtrace-executability.v1",
    milestone: "M213",
    generatedAt: new Date().toISOString(),
    method:
      "Per-repository offline dry run. Checkouts are extracted from cached SWE-bench eval images; "
      + "no test suite runs, no agent runs, no model is called, no image is pulled.",
    selectionRule:
      "Within each repository of the frozen population, the lexicographically first instance whose "
      + "eval image is already cached on this host. Outcome-blind; image availability recorded as an "
      + "infrastructure constraint.",
    vtraceCommit: (await run("git", ["rev-parse", "HEAD"], { cwd: VTRACE_ROOT })).stdout.trim(),
    vtraceTreeClean: (await run("git", ["status", "--porcelain"], { cwd: VTRACE_ROOT })).stdout
      .split("\n").filter((line) => line.trim().length > 0 && !line.includes("??")).length === 0,
    repositoriesIntended: population.repositories.length,
    repositoriesProbed: probes.length,
    repositoriesProven,
    uncoveredRepositories,
    allProven: repositoriesProven === population.repositories.length,
    observationalIndexing: probes.every((probe) => !probe.checkoutOk || probe.trackedSourceUnchanged),
    pathsIndexingCreates: [...new Set(probes.flatMap((probe) => probe.pathsCreatedByIndexing))].sort(),
    probes,
  };

  const outPath = path.join(outDir, "stage5_m213_vtrace_executability.json");
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`${outPath}\n`);
  process.stdout.write(
    `repositories proven ${repositoriesProven}/${population.repositories.length}; `
    + `observational indexing ${artifact.observationalIndexing}\n`,
  );
}

await main();
