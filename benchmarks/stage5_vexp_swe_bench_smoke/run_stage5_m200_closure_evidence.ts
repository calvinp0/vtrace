/**
 * M200 — the frozen C-LARGE k=3 closure, and a package-binding sequence (§11, §27, §36).
 *
 * Three things this reports that no other instrument does.
 *
 *   THE FROZEN CASE, mechanically. What the k=3 mutation does to `arc/__init__.py`
 *   — old surface digest, new surface digest, changed bindings, reverse
 *   consumers, plan mode, files parsed. §16 forbids tailoring anything to this
 *   fixture, so the evidence has to show that nothing was: the surface is
 *   unchanged, no closure is derived, and the cap is never consulted.
 *
 *   A PACKAGE-BINDING SEQUENCE on the real corpus. Add a re-export, redirect it,
 *   add a consumer, remove the export, restore it — five refreshes against one
 *   index, compared against a clean build of the final tree. A single refresh
 *   can be right by luck; a sequence has to stay right while the descriptor
 *   tables are rewritten under it.
 *
 *   DETERMINISM. The same package-surface refresh from the same start, three
 *   times, compared on closure, descriptor rows and graph hash (§39).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m200_closure_evidence.ts \
 *     [--repeats 3] [--scratch <dir>] [--out <name>]
 */
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { indexProject } from "../../src/indexer/indexProject";
import {
  bindingSurfaceDigest, type IndexedFileSnapshotSet,
} from "../../src/indexer/incrementalIndex";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { scanRepo } from "../../src/fs/scanRepo";
import { normalizedGraphHash } from "../../src/indexer/normalizedGraph";
import { SKIP_DIRS, corpusSpecs, prepareCorpus } from "./m197aFixtures";
import { compareProjections, fullSemanticProjection } from "./m199Equivalence";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const REPEATS = Number.parseInt(argOf("--repeats", "3"), 10);
const SCRATCH = argOf("--scratch", path.join(process.env.TMPDIR ?? "/tmp", "m200-closure"));
const OUT = argOf("--out", "stage5_m200_closure_evidence.json");
mkdirSync(SCRATCH, { recursive: true });
const PARSER = { parserVersion: "builtin-parser-v1" };

function openDb(root: string): Database {
  mkdirSync(path.join(root, ".vtrace"), { recursive: true });
  return openIndexerDatabase(path.join(root, ".vtrace", "index.sqlite"));
}

function copy(from: string, to: string): string {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, dereference: false,
    filter: (s) => !SKIP_DIRS.has(path.basename(s)) });
  rmSync(path.join(to, ".vtrace"), { recursive: true, force: true });
  return to;
}

const append = (root: string, rel: string, tag: string) =>
  writeFileSync(path.join(root, rel), `${readFileSync(path.join(root, rel), "utf8")}\n# ${tag}\n`);

const observed = (result: any) => ({
  mode: result?.performance?.mode ?? null,
  fallbackReason: result?.performance?.fallbackReason ?? null,
  modifiedFiles: result?.performance?.modifiedFiles ?? null,
  parsedFiles: result?.performance?.parsedFiles ?? null,
  affectedClosureFiles: result?.performance?.affectedClosureFiles ?? null,
  bindingClosure: result?.performance?.bindingClosure ?? null,
  totalSymbols: result?.totalSymbols ?? null,
  totalRelationships: result?.totalRelationships ?? null,
});

/** The persisted binding authority, as rows, for determinism comparison. */
function bindingRows(db: Database) {
  return {
    surfaces: db.query("SELECT file_path, surface_digest FROM module_binding_surfaces ORDER BY file_path").all(),
    bindings: db.query(`SELECT file_path, local_name, binding_kind, imported_name, target_path
      FROM module_bindings ORDER BY file_path, local_name, binding_kind`).all(),
    descriptors: db.query(`SELECT file_path, ordinal, resolved_target_path, resolution_status
      FROM import_descriptors ORDER BY file_path, ordinal`).all(),
  };
}

/** Derive a file's surface digest the way the indexer does, without indexing. */
async function surfaceDigestOf(root: string, relativePath: string): Promise<string | null> {
  const { createDefaultParserRegistry } = await import("../../src/indexer/indexProject");
  const scanned = await scanRepo(root);
  const contents = scanned.map((file) => ({
    file, content: readFileSync(path.join(root, file.path), "utf8"),
  }));
  const registry = createDefaultParserRegistry(contents as any);
  const target = contents.find((entry) => entry.file.path === relativePath);
  if (target === undefined) return null;
  const parsed: any = await registry.parse({
    path: target.file.path, content: target.content, language: target.file.language,
  });
  if (!parsed.ok || parsed.result.bindingSurface === undefined) return null;
  return bindingSurfaceDigest(parsed.result.bindingSurface);
}

const spec = corpusSpecs(REPO).find((entry) => entry.id === "C-LARGE")!;
const source = prepareCorpus(spec, SCRATCH);
if (source === null) throw new Error("C-LARGE source absent");

// ---------------------------------------------------------- the frozen k=3 case
const frozenRoot = copy(source, path.join(SCRATCH, "frozen"));
const frozenDb = openDb(frozenRoot);
const cold: any = await indexProject({ repoRoot: frozenRoot, db: frozenDb, ...PARSER });
let snapshot: IndexedFileSnapshotSet | undefined = cold.snapshot;
for (let i = 0; i < REPEATS; i += 1) {
  const noop: any = await indexProject({ repoRoot: frozenRoot, db: frozenDb,
    previousSnapshot: snapshot, hasExistingGraph: true, ...PARSER });
  snapshot = noop.snapshot ?? snapshot;
}
const scanned = (await scanRepo(frozenRoot)).map((f) => f.path)
  .filter((p) => spec.exts.some((e) => p.endsWith(e))).sort();
const k1Targets = scanned.slice(0, 1);
const k3Targets = scanned.slice(0, 3);
const packageTarget = k3Targets.find((p) => p.endsWith("__init__.py")) ?? null;

const frozen: Record<string, unknown> = { k1Targets, k3Targets, packageTarget };
for (const [label, targets] of [["k1", k1Targets], ["k3", k3Targets]] as const) {
  const before = packageTarget === null ? null : await surfaceDigestOf(frozenRoot, packageTarget);
  for (const rel of targets) append(frozenRoot, rel, `m200 closure evidence ${label}`);
  const after = packageTarget === null ? null : await surfaceDigestOf(frozenRoot, packageTarget);
  const result: any = await indexProject({ repoRoot: frozenRoot, db: frozenDb,
    previousSnapshot: snapshot, hasExistingGraph: true, ...PARSER });
  snapshot = result.snapshot ?? snapshot;
  frozen[label] = {
    targets,
    packageSurfaceDigestBefore: before, packageSurfaceDigestAfter: after,
    packageSurfaceChanged: before !== null && after !== null && before !== after,
    ...observed(result),
  };
  console.log(`frozen ${label}: mode=${(result.performance?.mode ?? "?").padEnd(13)} `
    + `parsed=${result.performance?.parsedFiles} surfaceChanged=${before !== after} `
    + `closure=${result.performance?.bindingClosure === undefined ? "none derived" : "derived"}`);
}
// Equality against a clean build of the mutated tree, so the frozen case's own
// result is not taken on the planner's word.
const frozenColdRoot = copy(frozenRoot, path.join(SCRATCH, "frozen-cold"));
const frozenColdDb = openDb(frozenColdRoot);
await indexProject({ repoRoot: frozenColdRoot, db: frozenColdDb, ...PARSER });
const frozenComparison = compareProjections(
  fullSemanticProjection(frozenDb), fullSemanticProjection(frozenColdDb));
frozen.equalToCleanRebuild = frozenComparison.equal;
frozen.unequalSections = frozenComparison.sections.filter((s) => !s.equal);
frozenColdDb.close();
frozenDb.close();
console.log(`frozen k1+k3 sequence equal to clean rebuild: ${frozenComparison.equal}`);

// -------------------------------------------------- package-binding sequence (§27)
const seqRoot = copy(source, path.join(SCRATCH, "seq"));
const seqDb = openDb(seqRoot);
const seqCold: any = await indexProject({ repoRoot: seqRoot, db: seqDb, ...PARSER });
let seqSnapshot: IndexedFileSnapshotSet | undefined = seqCold.snapshot;
const steps: unknown[] = [];
const pkg = "arc/__init__.py";
const original = readFileSync(path.join(seqRoot, pkg), "utf8");
const consumer = "m200_seq_consumer.py";

const step = async (label: string, mutate: () => void) => {
  mutate();
  const result: any = await indexProject({ repoRoot: seqRoot, db: seqDb,
    previousSnapshot: seqSnapshot, hasExistingGraph: true, ...PARSER });
  seqSnapshot = result.snapshot ?? seqSnapshot;
  steps.push({ label, ...observed(result) });
  console.log(`  seq ${label.padEnd(18)} ${(result.performance?.mode ?? "?").padEnd(13)} `
    + `parsed=${result.performance?.parsedFiles} `
    + `closure=${result.performance?.bindingClosure?.closureFiles?.length
        ?? result.performance?.bindingClosure?.refusal ?? "-"}`);
};

await step("add re-export", () =>
  writeFileSync(path.join(seqRoot, pkg), `${original}from arc.common import get_logger\n`));
await step("redirect re-export", () =>
  writeFileSync(path.join(seqRoot, pkg), `${original}from arc.plotter import get_logger\n`));
await step("add consumer", () =>
  writeFileSync(path.join(seqRoot, consumer),
    "from arc import get_logger\n\n\ndef use():\n    return get_logger()\n"));
await step("remove export", () => writeFileSync(path.join(seqRoot, pkg), original));
await step("restore export", () =>
  writeFileSync(path.join(seqRoot, pkg), `${original}from arc.common import get_logger\n`));

const seqColdRoot = copy(seqRoot, path.join(SCRATCH, "seq-cold"));
const seqColdDb = openDb(seqColdRoot);
await indexProject({ repoRoot: seqColdRoot, db: seqColdDb, ...PARSER });
const seqComparison = compareProjections(
  fullSemanticProjection(seqDb), fullSemanticProjection(seqColdDb));
seqColdDb.close();
seqDb.close();
console.log(`package-binding sequence equal to clean rebuild: ${seqComparison.equal}`);

// ------------------------------------------------------------- determinism (§39)
const repeats: unknown[] = [];
for (let attempt = 0; attempt < REPEATS; attempt += 1) {
  const root = copy(source, path.join(SCRATCH, `det-${attempt}`));
  const db = openDb(root);
  const base: any = await indexProject({ repoRoot: root, db, ...PARSER });
  writeFileSync(path.join(root, pkg), `${original}from arc.common import get_logger\n`);
  writeFileSync(path.join(root, consumer),
    "from arc import get_logger\n\n\ndef use():\n    return get_logger()\n");
  const first: any = await indexProject({ repoRoot: root, db,
    previousSnapshot: base.snapshot, hasExistingGraph: true, ...PARSER });
  writeFileSync(path.join(root, pkg), `${original}from arc.plotter import get_logger\n`);
  const result: any = await indexProject({ repoRoot: root, db,
    previousSnapshot: first.snapshot, hasExistingGraph: true, ...PARSER });
  repeats.push({
    attempt, ...observed(result),
    normalizedGraphHash: normalizedGraphHash(db),
    bindingRowsHash: Bun.hash(JSON.stringify(bindingRows(db))).toString(16),
  });
  db.close();
  rmSync(root, { recursive: true, force: true });
}
const identical = (key: string) => new Set(repeats.map((r: any) => JSON.stringify(r[key]))).size === 1;
const deterministic = ["normalizedGraphHash", "bindingRowsHash", "mode", "parsedFiles"]
  .every((key) => identical(key))
  && new Set(repeats.map((r: any) => JSON.stringify(r.bindingClosure?.closureFiles ?? null))).size === 1;
console.log(`determinism over ${REPEATS} repeats: ${deterministic}`);

const verdict = frozen.equalToCleanRebuild === true && seqComparison.equal && deterministic
  ? "PASS" : "FAIL";
writeFileSync(path.join(RESULTS, OUT), `${JSON.stringify({
  milestone: "M200",
  purpose: "frozen C-LARGE k=3 closure evidence, package-binding sequence, determinism",
  generatedFromCommit: (await Bun.$`git -C ${REPO} rev-parse HEAD`.text()).trim(),
  corpus: spec.id, repeats: REPEATS,
  frozen,
  packageBindingSequence: {
    steps, equal: seqComparison.equal,
    unequalSections: seqComparison.sections.filter((s) => !s.equal),
  },
  determinism: { deterministic, repeats },
  verdict,
}, null, 2)}\n`);
console.log(`\n${verdict} -> wrote results/${OUT}`);
