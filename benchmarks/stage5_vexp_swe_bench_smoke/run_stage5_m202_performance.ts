/**
 * M202 — startup, grammar initialisation, memory and mixed-corpus throughput
 * (§32, §44, §45).
 *
 * Each measurement that depends on process state runs in a FRESH `bun`
 * process, because a grammar loaded once is cached and a warm number would be
 * reported as a cold one:
 *
 *   registry creation      what every index run and every query pays: the
 *                          default registry with no grammar loaded
 *   per-family init        first dlopen + first parse, then a second parse, in
 *                          one process per family
 *   peak RSS               a process that loads every grammar and parses every
 *                          fixture, against one that builds the registry only
 *   mixed-corpus throughput cold `indexProject` over the M202 fixture repository,
 *                          three repeats, files/s
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m202_performance.ts
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { indexProject } from "../../src/indexer/indexProject";
import { structuralFamilies } from "../../src/parsers/languageFamilies";
import { median } from "./m197aFixtures";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const FIXTURES = path.join(import.meta.dir, "fixtures", "m202_language_families");
const SCRATCH = path.join(process.env.TMPDIR ?? "/tmp", "m202-perf");

function fresh(script: string): { ok: boolean; value: any; wallMs: number } {
  const t0 = performance.now();
  const r = spawnSync("bun", ["-e", script], { cwd: REPO, encoding: "utf8", env: { ...process.env, M202_QUIET: "1" } });
  const wallMs = performance.now() - t0;
  try { return { ok: r.status === 0, value: JSON.parse(r.stdout.trim().split("\n").at(-1)!), wallMs }; }
  catch { return { ok: false, value: r.stderr.slice(0, 300), wallMs }; }
}
const loadAverage = () => readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number);

// ---------------------------------------------------- registry creation cost
const registryRuns = Array.from({ length: 5 }, () => fresh(`
  const t0 = performance.now();
  const { createDefaultParserRegistry } = await import("./src/indexer/indexProject");
  const t1 = performance.now();
  const registry = createDefaultParserRegistry([]);
  const t2 = performance.now();
  const { loadedGrammarCount } = await import("./src/parsers/treeSitterGrammars");
  console.log(JSON.stringify({ importMs: +(t1 - t0).toFixed(2), createMs: +(t2 - t1).toFixed(2), registered: registry.registeredLanguages().length, grammarsLoaded: loadedGrammarCount(), rssMiB: +(process.memoryUsage().rss / 1048576).toFixed(1) }));
`));

// ---------------------------------------------- per-family initialisation
const perFamily = structuralFamilies().map((family) => {
  const dir = path.join(FIXTURES, family.language);
  const valid = readdirSync(dir).find((f) => f.startsWith("valid."))!;
  const run = fresh(`
    const { readFileSync } = await import("node:fs");
    const { createStructuralParser } = await import("./src/parsers/structuralParser");
    const content = readFileSync(${JSON.stringify(path.join(dir, valid))}, "utf8");
    const parser = createStructuralParser(${JSON.stringify(family.language)});
    const input = { path: ${JSON.stringify(`x/${valid}`)}, content, language: ${JSON.stringify(family.language)} };
    const before = process.memoryUsage().rss;
    const t0 = performance.now(); await parser.parse(input); const first = performance.now() - t0;
    const t1 = performance.now(); await parser.parse(input); const second = performance.now() - t1;
    console.log(JSON.stringify({ firstParseMs: +first.toFixed(2), secondParseMs: +second.toFixed(2), rssDeltaMiB: +((process.memoryUsage().rss - before) / 1048576).toFixed(1) }));
  `);
  return { language: family.language, fixture: valid, ...(run.ok ? run.value : { error: run.value }) };
});

// -------------------------------------------------------------- peak RSS
const rssRegistryOnly = fresh(`
  const { createDefaultParserRegistry } = await import("./src/indexer/indexProject");
  createDefaultParserRegistry([]);
  console.log(JSON.stringify({ rssMiB: +(process.memoryUsage().rss / 1048576).toFixed(1) }));
`);
const rssAllGrammars = fresh(`
  const { readdirSync, readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { createDefaultParserRegistry } = await import("./src/indexer/indexProject");
  const { structuralFamilies } = await import("./src/parsers/languageFamilies");
  const { loadedGrammarCount } = await import("./src/parsers/treeSitterGrammars");
  const registry = createDefaultParserRegistry([]);
  const F = ${JSON.stringify(FIXTURES)};
  for (const family of structuralFamilies()) {
    const dir = path.join(F, family.language);
    const valid = readdirSync(dir).find((f) => f.startsWith("valid."));
    await registry.parse({ path: "x/" + valid, content: readFileSync(path.join(dir, valid), "utf8"), language: family.language });
  }
  console.log(JSON.stringify({ rssMiB: +(process.memoryUsage().rss / 1048576).toFixed(1), grammarsLoaded: loadedGrammarCount() }));
`);

// ---------------------------------------------- mixed-corpus throughput
rmSync(SCRATCH, { recursive: true, force: true });
const corpus = path.join(SCRATCH, "corpus");
mkdirSync(corpus, { recursive: true });
// 8 copies of every valid fixture: enough files that per-file cost dominates setup.
let fileCount = 0;
for (const family of structuralFamilies()) {
  const dir = path.join(FIXTURES, family.language);
  const valid = readdirSync(dir).find((f) => f.startsWith("valid."))!;
  for (let i = 0; i < 8; i += 1) {
    const target = path.join(corpus, family.language, `copy${i}`, valid);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(dir, valid), target);
    fileCount += 1;
  }
}
const throughput: number[] = [];
for (let i = 0; i < 3; i += 1) {
  rmSync(path.join(corpus, ".vtrace"), { recursive: true, force: true });
  mkdirSync(path.join(corpus, ".vtrace"), { recursive: true });
  const db = openIndexerDatabase(path.join(corpus, ".vtrace", "index.sqlite"));
  const t0 = performance.now();
  const result = await indexProject({ repoRoot: corpus, db });
  const ms = performance.now() - t0;
  db.close();
  throughput.push(+(1000 * result.totalFilesSuccessfullyIndexed / ms).toFixed(1));
}

const deps = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m202_dependency_audit.json"), "utf8"));
const out = {
  milestone: "M202", instrument: "run_stage5_m202_performance.ts",
  loadAverage: loadAverage(), cpus: navigator.hardwareConcurrency,
  registryCreation: {
    runs: registryRuns.map((r) => r.value),
    createMsMedian: median(registryRuns.map((r) => r.value.createMs)),
    grammarsLoadedAtCreation: registryRuns[0]!.value.grammarsLoaded,
    lazy: registryRuns.every((r) => r.value.grammarsLoaded === 0),
  },
  perFamily,
  perFamilyMedians: {
    firstParseMs: median(perFamily.filter((p) => p.firstParseMs !== undefined).map((p) => p.firstParseMs)),
    secondParseMs: median(perFamily.filter((p) => p.secondParseMs !== undefined).map((p) => p.secondParseMs)),
    firstParseMaxMs: Math.max(...perFamily.map((p) => p.firstParseMs ?? 0)),
    slowestFirst: [...perFamily].sort((a, b) => (b.firstParseMs ?? 0) - (a.firstParseMs ?? 0)).slice(0, 3).map((p) => `${p.language}:${p.firstParseMs}ms`),
  },
  memory: {
    registryOnlyRssMiB: rssRegistryOnly.value.rssMiB,
    allGrammarsLoadedRssMiB: rssAllGrammars.value.rssMiB,
    grammarsLoaded: rssAllGrammars.value.grammarsLoaded,
    deltaMiB: +(rssAllGrammars.value.rssMiB - rssRegistryOnly.value.rssMiB).toFixed(1),
    cacheBound: "one Parser and one language object per (family, export); never evicted; at most 29 entries",
  },
  mixedCorpusThroughput: { files: fileCount, filesPerSecond: throughput, median: median(throughput) },
  dependencyFootprint: { grammarPackages: deps.totals.grammarPackages, unpackedMiB: deps.totals.unpackedMiB, compiledAtInstall: deps.totals.compiledAtInstall },
};
writeFileSync(path.join(RESULTS, "stage5_m202_performance.json"), `${JSON.stringify(out, null, 2)}\n`);
const md = [`# M202 — performance and resource impact\n`,
  `Load ${out.loadAverage.join(" ")} on ${out.cpus} cpus.\n`,
  `- registry creation (fresh process, median of 5): ${out.registryCreation.createMsMedian} ms, grammars loaded at creation: ${out.registryCreation.grammarsLoadedAtCreation} (lazy: ${out.registryCreation.lazy})`,
  `- per-family first parse (dlopen + parse) median ${out.perFamilyMedians.firstParseMs} ms, max ${out.perFamilyMedians.firstParseMaxMs} ms (${out.perFamilyMedians.slowestFirst.join(", ")}); second parse median ${out.perFamilyMedians.secondParseMs} ms`,
  `- RSS: registry only ${out.memory.registryOnlyRssMiB} MiB; all ${out.memory.grammarsLoaded} grammars loaded and parsed ${out.memory.allGrammarsLoadedRssMiB} MiB (+${out.memory.deltaMiB} MiB)`,
  `- mixed corpus (${fileCount} files, 27 families): ${throughput.join(" / ")} files/s, median ${out.mixedCorpusThroughput.median}`,
  `- dependency footprint: ${deps.totals.grammarPackages} grammar packages, ${deps.totals.unpackedMiB} MiB unpacked, ${deps.totals.compiledAtInstall} compiled at install`,
  ``, `| family | first parse ms | second parse ms | RSS delta MiB |`, `| --- | ---: | ---: | ---: |`,
  ...perFamily.map((p) => `| ${p.language} | ${p.firstParseMs ?? p.error} | ${p.secondParseMs ?? ""} | ${p.rssDeltaMiB ?? ""} |`)];
writeFileSync(path.join(RESULTS, "stage5_m202_performance.md"), `${md.join("\n")}\n`);
console.log(md.slice(0, 8).join("\n"));
