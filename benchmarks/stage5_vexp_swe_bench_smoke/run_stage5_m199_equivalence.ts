/**
 * M199 — incremental/full equivalence, sequence equivalence, determinism, and
 * the falsification controls F1-F7 (§18-§20, §26, §32).
 *
 * Every comparison is between two SEPARATE working copies of the same corpus:
 * one refreshed incrementally, one built cold from the final filesystem state.
 * They are compared over the full projection in `m199Equivalence.ts`, which
 * includes the three tables the product's own `normalizeGraph` does not.
 *
 * A note on what "6/6" means here. Four of the six mutations legitimately route
 * to a full rebuild — the planner cannot bound the closure of an add, a delete,
 * a rename or a package-surface edit — so this instrument records the mode each
 * mutation actually took. A mutation that quietly stopped being incremental
 * would otherwise pass equivalence and hide the regression.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m199_equivalence.ts \
 *     [--corpora C-SMALL,C-MED,C-LARGE] [--repeats 3] [--scratch <dir>] [--out <name>]
 */
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { indexProject } from "../../src/indexer/indexProject";
import type { IndexedFileSnapshotSet } from "../../src/indexer/incrementalIndex";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { scanRepo } from "../../src/fs/scanRepo";
import { SKIP_DIRS, corpusSpecs, prepareCorpus } from "./m197aFixtures";
import {
  compareProjections, fullSemanticProjection, summarizeComparison,
} from "./m199Equivalence";
import {
  accountRefresh, affectedSemanticRows, installWriteCounters, semanticWritesAreBounded,
} from "./m199PersistenceAccounting";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const SCRATCH = argOf("--scratch", path.join(process.env.TMPDIR ?? "/tmp", "m199eq"));
const ONLY = argOf("--corpora", "C-SMALL,C-MED,C-LARGE").split(",").map((s) => s.trim());
const REPEATS = Number.parseInt(argOf("--repeats", "3"), 10);
const OUT = argOf("--out", "stage5_m199_equivalence.json");
const PARSER_VERSION = "builtin-parser-v1";
mkdirSync(SCRATCH, { recursive: true });

const marker = (spec: { readonly exts: readonly string[] }) => spec.exts.includes(".py") ? "#" : "//";

function openIndexDb(work: string): Database {
  mkdirSync(path.join(work, ".vtrace"), { recursive: true });
  return openIndexerDatabase(path.join(work, ".vtrace", "index.sqlite"));
}

function copyCorpus(source: string, work: string): void {
  rmSync(work, { recursive: true, force: true });
  cpSync(source, work, { recursive: true, dereference: false,
    filter: (s) => !SKIP_DIRS.has(path.basename(s)) });
}

const refresh = (repoRoot: string, db: Database, snapshot?: IndexedFileSnapshotSet) =>
  indexProject({ repoRoot, db, parserVersion: PARSER_VERSION,
    ...(snapshot === undefined ? {} : { previousSnapshot: snapshot }), hasExistingGraph: true });

const cold = (repoRoot: string, db: Database) =>
  indexProject({ repoRoot, db, parserVersion: PARSER_VERSION });

async function sourceFiles(root: string, exts: readonly string[]): Promise<string[]> {
  return (await scanRepo(root)).map((f) => f.path)
    .filter((p) => exts.some((e) => p.endsWith(e))).sort();
}

/**
 * The six mutation classes (§18). Each is applied identically to the incremental
 * copy and to the cold copy, so the two are compared against the SAME final
 * filesystem, never against two different repositories that happen to be close.
 */
interface Mutation {
  readonly id: string;
  readonly apply: (root: string, files: readonly string[], mark: string) => void;
}

const MUTATIONS: readonly Mutation[] = [
  { id: "E1-modify-1", apply: (root, files, mark) => append(root, files[0]!, mark, "E1") },
  { id: "E2-modify-3", apply: (root, files, mark) => {
    for (const rel of files.slice(0, 3)) append(root, rel, mark, "E2");
  } },
  { id: "E3-add-file", apply: (root, files, mark) => {
    const target = path.join(root, path.dirname(files[0]!), "m199_added_probe" + path.extname(files[0]!));
    writeFileSync(target, addedFileBody(mark));
  } },
  { id: "E4-delete-file", apply: (root, files) => rmSync(path.join(root, deletableFile(files))) },
  { id: "E5-rename-file", apply: (root, files) => {
    const from = deletableFile(files);
    const to = path.join(path.dirname(from), `m199_renamed_${path.basename(from)}`);
    writeFileSync(path.join(root, to), readFileSync(path.join(root, from)));
    rmSync(path.join(root, from));
  } },
  { id: "E6-remove-symbol", apply: (root, files, mark) => {
    // Remove the last top-level definition by truncating at its header. Falls
    // back to emptying the file, which is still a genuine symbol removal.
    const rel = deletableFile(files);
    const full = path.join(root, rel);
    const lines = readFileSync(full, "utf8").split("\n");
    const isHeader = (line: string) => mark === "#"
      ? /^(def |class |async def )/.test(line)
      : /^(export )?(function|class|const|interface|type) /.test(line);
    let cut = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) if (isHeader(lines[i]!)) { cut = i; break; }
    writeFileSync(full, cut === -1 ? `${mark} m199 emptied\n` : `${lines.slice(0, cut).join("\n")}\n`);
  } },
];

function append(root: string, rel: string, mark: string, tag: string): void {
  const full = path.join(root, rel);
  writeFileSync(full, `${readFileSync(full, "utf8")}\n${mark} m199 ${tag}\n`);
}

function addedFileBody(mark: string): string {
  return mark === "#"
    ? "def m199_added():\n    return 1\n"
    : "export function m199Added(): number {\n  return 1;\n}\n";
}

/**
 * A file safe to delete, rename or truncate: never a package surface, because
 * removing one changes what every importer resolves to and the mutation would be
 * testing the corpus rather than the index. Chosen deterministically by path.
 */
function deletableFile(files: readonly string[]): string {
  const candidate = files.find((rel) => !/(^|\/)(__init__\.py|index\.[cm]?[jt]sx?)$/.test(rel));
  if (candidate === undefined) throw new Error("M199_NO_DELETABLE_FILE");
  return candidate;
}

const specs = corpusSpecs(REPO).filter((s) => ONLY.includes(s.id));
const corpora: any[] = [];

for (const spec of specs) {
  const prepared = prepareCorpus(spec, SCRATCH);
  if (prepared === null) { corpora.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }
  const mark = marker(spec);
  const mutations: any[] = [];

  // ------------------------------------------------------- E1-E6 equivalence
  for (const mutation of MUTATIONS) {
    const incRoot = path.join(SCRATCH, `inc-${spec.id}`);
    const coldRoot = path.join(SCRATCH, `cold-${spec.id}`);
    copyCorpus(prepared, incRoot);
    copyCorpus(prepared, coldRoot);
    const incDb = openIndexDb(incRoot);
    const coldDb = openIndexDb(coldRoot);
    try {
      const base = await cold(incRoot, incDb);
      const noop = await refresh(incRoot, incDb, (base as any).snapshot);
      const files = await sourceFiles(incRoot, spec.exts);
      mutation.apply(incRoot, files, mark);
      mutation.apply(coldRoot, files, mark);
      const refreshed: any = await refresh(incRoot, incDb, (noop as any).snapshot ?? (base as any).snapshot);
      await cold(coldRoot, coldDb);

      const comparison = compareProjections(fullSemanticProjection(incDb), fullSemanticProjection(coldDb));
      mutations.push({
        id: mutation.id,
        mode: refreshed.performance?.mode,
        fallbackReason: refreshed.performance?.fallbackReason ?? null,
        parsedFiles: refreshed.performance?.parsedFiles,
        ...summarizeComparison(comparison),
      });
      console.log(`  ${spec.id} ${mutation.id.padEnd(16)} ${refreshed.performance?.mode?.padEnd(13)} `
        + `equal=${comparison.equal}`);
    } catch (error: any) {
      mutations.push({ id: mutation.id, equal: false, error: String(error?.message ?? error).slice(0, 300) });
      console.log(`  ${spec.id} ${mutation.id.padEnd(16)} THREW ${String(error?.message ?? error).slice(0, 120)}`);
    } finally { incDb.close(); coldDb.close(); }
    rmSync(incRoot, { recursive: true, force: true });
    rmSync(coldRoot, { recursive: true, force: true });
  }

  // ----------------------------------------------- sequence equivalence (§20)
  const seqRoot = path.join(SCRATCH, `seq-${spec.id}`);
  const seqColdRoot = path.join(SCRATCH, `seqcold-${spec.id}`);
  copyCorpus(prepared, seqRoot);
  const seqDb = openIndexDb(seqRoot);
  const steps: any[] = [];
  try {
    const base = await cold(seqRoot, seqDb);
    let snapshot: IndexedFileSnapshotSet | undefined = (base as any).snapshot;
    const files = await sourceFiles(seqRoot, spec.exts);
    const a = files[0]!;
    const b = files[1]!;
    const c = path.join(path.dirname(a), `m199_seq_added${path.extname(a)}`);

    const run = async (label: string, mutate: () => void) => {
      mutate();
      const result: any = await refresh(seqRoot, seqDb, snapshot);
      snapshot = result.snapshot ?? snapshot;
      steps.push({ label, mode: result.performance?.mode,
        fallbackReason: result.performance?.fallbackReason ?? null,
        parsedFiles: result.performance?.parsedFiles });
      console.log(`  ${spec.id} seq ${label.padEnd(10)} ${result.performance?.mode}`);
    };

    await run("modify A", () => append(seqRoot, a, mark, "S1"));
    await run("modify B", () => append(seqRoot, b, mark, "S2"));
    await run("delete A", () => rmSync(path.join(seqRoot, a)));
    await run("add C", () => writeFileSync(path.join(seqRoot, c), addedFileBody(mark)));
    await run("modify C", () => append(seqRoot, c, mark, "S5"));

    // The cold side is built from the sequence's FINAL filesystem, copied after
    // every step has been applied — never replayed, so a replay bug cannot make
    // the two agree.
    copyCorpus(seqRoot, seqColdRoot);
    rmSync(path.join(seqColdRoot, ".vtrace"), { recursive: true, force: true });
    const seqColdDb = openIndexDb(seqColdRoot);
    await cold(seqColdRoot, seqColdDb);
    const comparison = compareProjections(fullSemanticProjection(seqDb), fullSemanticProjection(seqColdDb));
    seqColdDb.close();
    corpora.push({ id: spec.id, mutations, sequence: { steps, ...summarizeComparison(comparison) } });
    console.log(`  ${spec.id} sequence equal=${comparison.equal}`);
  } catch (error: any) {
    corpora.push({ id: spec.id, mutations,
      sequence: { steps, equal: false, error: String(error?.message ?? error).slice(0, 300) } });
  } finally { seqDb.close(); }
  rmSync(seqRoot, { recursive: true, force: true });
  rmSync(seqColdRoot, { recursive: true, force: true });
}

// --------------------------------------------- determinism + boundedness (§26, F1/F5/F7)
const determinism: any[] = [];
for (const spec of specs) {
  const prepared = prepareCorpus(spec, SCRATCH);
  if (prepared === null) continue;
  const mark = marker(spec);
  const hashes: string[] = [];
  const writes: number[] = [];
  const amplifications: (number | null)[] = [];
  const noopWrites: number[] = [];
  let detail: any = null;

  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const root = path.join(SCRATCH, `det-${spec.id}`);
    copyCorpus(prepared, root);
    const db = openIndexDb(root);
    try {
      const base: any = await cold(root, db);
      installWriteCounters(db);
      let snapshot: IndexedFileSnapshotSet | undefined = base.snapshot;

      const noop = await accountRefresh(db, () => refresh(root, db, snapshot));
      snapshot = (noop.value as any).snapshot ?? snapshot;
      noopWrites.push(noop.accounting.semanticRowsWritten);

      const files = await sourceFiles(root, spec.exts);
      append(root, files[0]!, mark, "D1");
      const affected = affectedSemanticRows(db, [files[0]!]);
      const k1 = await accountRefresh(db, () => refresh(root, db, snapshot));
      const bounded = semanticWritesAreBounded(k1.accounting.semanticRowsWritten, affected.total);
      hashes.push(fullSemanticProjection(db).normalizedGraphHash);
      writes.push(k1.accounting.semanticRowsWritten);
      amplifications.push(bounded.amplification);
      if (repeat === 0) {
        detail = { affectedSemanticRowsBefore: affected.total, affectedByTable: affected.byTable,
          byTable: k1.accounting.byTable, boundedness: bounded,
          mode: (k1.value as any).performance?.mode };
      }
    } finally { db.close(); }
    rmSync(root, { recursive: true, force: true });
  }

  determinism.push({
    id: spec.id, repeats: REPEATS,
    normalizedGraphHashes: hashes,
    hashesIdentical: new Set(hashes).size === 1,
    semanticRowsWritten: writes,
    writeCountsIdentical: new Set(writes).size === 1,
    amplifications,
    noopSemanticRowsWritten: noopWrites,
    noopIsSilent: noopWrites.every((w) => w === 0),
    k1: detail,
  });
  const d = determinism.at(-1)!;
  console.log(`${spec.id} determinism hashes=${d.hashesIdentical} writes=${JSON.stringify(writes)} `
    + `amp=${JSON.stringify(amplifications)} noopSilent=${d.noopIsSilent}`);
}

const controls = {
  F1_bounded_semantic_writes: determinism.every((d) => d.k1?.boundedness?.bounded === true),
  F3_F4_F6_equivalence: corpora.every((c) => c.status === "CORPUS_ABSENT"
    || (c.mutations.every((m: any) => m.equal) && c.sequence?.equal === true)),
  F5_noop_writes_nothing: determinism.every((d) => d.noopIsSilent),
  F7_deterministic_graph: determinism.every((d) => d.hashesIdentical && d.writeCountsIdentical),
};

const out = {
  milestone: "M199",
  instrument: "run_stage5_m199_equivalence.ts",
  repeats: REPEATS,
  hardware: { cpus: navigator.hardwareConcurrency,
    loadAverageAtEnd: existsSync("/proc/loadavg")
      ? readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number) : [] },
  corpora,
  determinism,
  controls,
};
writeFileSync(path.join(RESULTS, OUT), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\ncontrols ${JSON.stringify(controls)}`);
console.log(`wrote results/${OUT}`);
