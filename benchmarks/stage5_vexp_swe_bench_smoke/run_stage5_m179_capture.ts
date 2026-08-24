/**
 * M179-B — freeze the authoritative objects the monotonicity ladders run over.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m179_capture.ts --corpus broad100a
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m179_capture.ts --corpus broad100b
 *
 * Captured at detail=debug, max_tokens 120,000 and `include_item_content`, which
 * together give the packer's own input rather than a packed view of it. See
 * `m179Capture.ts` for why the third of those is not optional.
 *
 * Cached by instance id. Offline: local index reads over MCP stdio, no agent,
 * no Docker, no paid API.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadProblemStatements } from "./m175Capture";
import { captureAuthoritative, carriesItemBodies, M179_CAPTURE_MAX_TOKENS } from "./m179Capture";
import { authoritativeIdentity, hashOf } from "./m179Packing";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const DATASET = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const CORPUS_ROOT = path.join(RESULTS, "_m179_authoritative");

interface ManifestCase { readonly instanceId: string; readonly repoRoot: string }

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const corpus = argv[argv.indexOf("--corpus") + 1] ?? "broad100a";
  const manifestPath = path.join(RESULTS, "_m171_capture", `${corpus}.manifest.json`);
  if (!existsSync(manifestPath)) throw new Error(`missing capture manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    vtraceCommit?: string; cases: readonly ManifestCase[];
  };
  const tasks = loadProblemStatements(DATASET);
  const cacheDir = path.join(CORPUS_ROOT, corpus);

  const rows: Array<Record<string, unknown>> = [];
  let captured = 0;
  let failed = 0;
  let bodiless = 0;
  for (const entry of manifest.cases) {
    const task = tasks.get(entry.instanceId);
    if (task === undefined || !existsSync(entry.repoRoot)) {
      failed += 1;
      rows.push({ instanceId: entry.instanceId, captured: false, error: task === undefined ? "task_not_in_dataset" : "repo_root_missing" });
      continue;
    }
    const result = await captureAuthoritative(cacheDir, entry.instanceId, entry.repoRoot, task);
    if (result.snapshot === null || result.error !== null) {
      failed += 1;
      rows.push({ instanceId: entry.instanceId, captured: false, error: result.error });
      console.log(`${entry.instanceId.padEnd(36)} FAILED ${result.error}`);
      continue;
    }
    const bodies = carriesItemBodies(result.snapshot);
    if (!bodies.valid) bodiless += 1;
    captured += 1;
    rows.push({
      instanceId: entry.instanceId,
      captured: true,
      repoRoot: entry.repoRoot,
      authoritativeCharacters: JSON.stringify(result.snapshot).length,
      itemBodies: bodies,
      identity: authoritativeIdentity(result.snapshot),
    });
    console.log(`${entry.instanceId.padEnd(36)} ok  items=${String(bodies.items).padStart(3)} withBody=${String(bodies.withContent).padStart(3)}`);
  }

  const out = {
    schemaVersion: "stage5.m179.authoritative-corpus.v2",
    milestone: "M179",
    workstream: "B",
    corpus,
    capturedAtMaxTokens: M179_CAPTURE_MAX_TOKENS,
    capturedDetail: "debug",
    includeItemContent: true,
    sourceManifest: path.relative(ROOT, manifestPath),
    sourceManifestVtraceCommit: manifest.vtraceCommit ?? null,
    cacheDir: path.relative(ROOT, cacheDir),
    summary: { requested: manifest.cases.length, captured, failed, capturedWithoutItemBodies: bodiless },
    corpusIdentityHash: hashOf(rows.map((row) => [row.instanceId, (row.identity as Record<string, unknown> | undefined)?.objectHash ?? null])),
    rows,
  };
  const outPath = path.join(RESULTS, `stage5_m179_authoritative_corpus_manifest.${corpus}.json`);
  writeFileSync(outPath, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`\ncaptured=${captured} failed=${failed} bodiless=${bodiless} -> ${path.relative(ROOT, outPath)}`);
}

await main();
