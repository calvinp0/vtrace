/**
 * M146-A. Fail-closed coverage guard for the index derivation fingerprint.
 *
 * The compatibility contract is only as good as the set of source files hashed
 * into it, and before M146-A that set was a hand-maintained list of directories
 * while the real boundary is the import closure of the index WRITE path. Two
 * functions had drifted across it: the FTS tokenizer, which lived in
 * `src/retrieval` (excluded from every fingerprint so that ranking changes do
 * not force rebuilds) yet produced the stored `symbol_search_fts` rows; and the
 * stored-identity derivation in `src/domain/types`. Changing either altered the
 * contents of a rebuilt index while every existing index still reported
 * `ready: true` — a stale semantic derivation served as current.
 *
 * This test walks that closure and fails when a VALUE import reaches source
 * that no fingerprint hashes. Type-only imports are ignored: they cannot change
 * behaviour, and following them drags in the whole capsule/skeleton/projectRules
 * graph, which would make ranking edits invalidate every index (the opposite
 * failure — unnecessary rebuilds).
 *
 * A module reached by a value import must therefore either
 *   (a) contribute to a fingerprint, or
 *   (b) appear in `ALLOWED_UNFINGERPRINTED` with a rationale for why changing it
 *       cannot alter state that indexing regenerates.
 *
 * Every exemption is additionally paired with a behavioural control below,
 * which mutates the real file and asserts that both the fingerprints and the
 * persisted index output are unchanged. An exemption that stops being true
 * fails there rather than silently widening the hole.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Database } from "bun:sqlite";

import { initRepo } from "../setup/initRepo";
import { computeIndexFingerprints, resolveIndexDbPath } from "./indexMeta";

const execFile = promisify(execFileCallback);
const VTRACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where index production starts: the indexer itself, and the meta it writes. */
const WRITE_PATH_ENTRIES = ["src/indexer/indexProject.ts", "src/indexer/indexMeta.ts"] as const;

/**
 * Modules the write path reaches by value that are deliberately NOT hashed.
 * Each rationale must explain why a change cannot alter regenerated index state.
 */
const ALLOWED_UNFINGERPRINTED: Readonly<Record<string, string>> = {
  "src/cli/progress.ts":
    "Progress reporting only. The indexer pushes phase events into a reporter and "
    + "never reads a value back, so no reporter change can reach stored index content.",
  "src/memory/computeFileDiff.ts":
    "Read-time. `listFileDiffsForRun` computes diffs on demand from persisted run "
    + "states; no diff output is written by an index run, so a rebuild cannot embed it.",
  "src/memory/computeSymbolDiff.ts":
    "Read-time, exactly as computeFileDiff: consumed by `listSymbolDiffsForRun` when "
    + "a caller asks, never persisted during indexing.",
  "src/memory/types.ts":
    "Declarations plus the run-state shapes the diff helpers above operate on. "
    + "Reached only through those read-time helpers.",
  "src/setup/types.ts":
    "Contributes constants, not logic. `INIT_STATE_SCHEMA_VERSION` is embedded BY "
    + "VALUE in `schema_version`, so bumping it already invalidates; the remaining "
    + "exports name the .vtrace directory and db file, which are locations rather "
    + "than derivation semantics.",
};

// ---------------------------------------------------------------------------
// Closure walk
// ---------------------------------------------------------------------------

/**
 * Specifiers imported for their runtime value. A statement is skipped only when
 * EVERY binding it introduces is a type (`import type …`, or a brace list whose
 * every entry is `type X`).
 */
function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];

  for (const match of source.matchAll(/(?:^|[\n;])\s*(?:import|export)\s+([\s\S]*?)\s*from\s*["']([^"']+)["']/g)) {
    const clause = match[1]!.trim();

    if (/^type\b/.test(clause)) {
      continue;
    }

    const braced = clause.match(/^\{([\s\S]*)\}$/);
    if (braced !== null) {
      const bindings = braced[1]!.split(",").map((binding) => binding.trim()).filter(Boolean);
      if (bindings.length > 0 && bindings.every((binding) => /^type\s/.test(binding))) {
        continue;
      }
    }

    specifiers.push(match[2]!);
  }

  // Side-effect imports run module top level, so they are value imports.
  for (const match of source.matchAll(/(?:^|[\n;])\s*import\s+["']([^"']+)["']/g)) {
    specifiers.push(match[1]!);
  }

  return specifiers;
}

async function resolveRelativeImport(fromFile: string, specifier: string): Promise<string | null> {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Not this candidate.
    }
  }
  return null;
}

/** Repo-relative files reachable from the entries through value imports. */
async function walkValueImportClosure(): Promise<Map<string, string>> {
  const reachedVia = new Map<string, string>();
  const queue = WRITE_PATH_ENTRIES.map((entry) => path.join(VTRACE_ROOT, entry));
  const seen = new Set(queue.map((file) => path.relative(VTRACE_ROOT, file)));

  while (queue.length > 0) {
    const file = queue.shift()!;
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }

    for (const specifier of valueImportSpecifiers(source)) {
      const resolved = await resolveRelativeImport(file, specifier);
      if (resolved === null) continue;

      const relative = path.relative(VTRACE_ROOT, resolved);
      if (seen.has(relative)) continue;

      seen.add(relative);
      reachedVia.set(relative, path.relative(VTRACE_ROOT, file));
      queue.push(resolved);
    }
  }

  return reachedVia;
}

// The fingerprint inputs, mirrored from indexMeta. Kept as literals on purpose:
// if the production lists change, this test must be re-reviewed rather than
// silently agreeing with whatever the implementation now happens to hash.
const FINGERPRINTED_DIRS = ["src/parsers", "src/indexer", "src/db"] as const;
const FINGERPRINTED_FILES = [
  "src/db/schema.ts",
  "src/domain/types.ts",
  "src/domain/guards.ts",
  "src/fs/hashFile.ts",
  "src/fs/git.ts",
  "src/fs/scanRepo.ts",
  "src/fs/worktreeExclusions.ts",
  "src/fs/ignoreRules.ts",
  "src/fs/languageDetection.ts",
  "src/documents/documentPolicy.ts",
  "src/documents/documentChunks.ts",
] as const;

async function collectTsSources(directory: string, into: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectTsSources(entryPath, into);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.includes(".test.")) continue;
    into.push(entryPath);
  }
}

async function fingerprintedFiles(): Promise<Set<string>> {
  const collected = FINGERPRINTED_FILES.map((file) => path.join(VTRACE_ROOT, file));
  for (const dir of FINGERPRINTED_DIRS) {
    await collectTsSources(path.join(VTRACE_ROOT, dir), collected);
  }
  return new Set(collected.map((file) => path.relative(VTRACE_ROOT, file)));
}

describe("M146-A indexer fingerprint coverage", () => {
  test("every value import from the index write path is fingerprinted or exempted", async () => {
    const [reachedVia, covered] = await Promise.all([walkValueImportClosure(), fingerprintedFiles()]);

    const unclassified = [...reachedVia.keys()]
      .filter((file) => !covered.has(file) && ALLOWED_UNFINGERPRINTED[file] === undefined)
      .sort()
      .map((file) => `${file} (reached from ${reachedVia.get(file)})`);

    // A new value import into unhashed source means a change there can alter a
    // rebuilt index while old indexes still report ready. Hash it, or exempt it
    // with a rationale AND a behavioural control below.
    expect(unclassified).toEqual([]);
  });

  test("every exemption is still reachable and still carries a rationale", async () => {
    const reachedVia = await walkValueImportClosure();

    // A stale exemption is a hole waiting to be reopened under a name nobody
    // rechecks, so drop entries the write path no longer reaches.
    const unreachable = Object.keys(ALLOWED_UNFINGERPRINTED)
      .filter((file) => !reachedVia.has(file))
      .sort();
    expect(unreachable).toEqual([]);

    for (const [file, rationale] of Object.entries(ALLOWED_UNFINGERPRINTED)) {
      expect(rationale.length, `${file} needs a substantive rationale`).toBeGreaterThan(60);
    }
  });

  test("the fingerprint inputs asserted here match the implementation", async () => {
    // Guards against this test drifting into agreement-by-omission: if indexMeta
    // stops hashing something listed above, coverage claims become fiction.
    const source = await readFile(path.join(VTRACE_ROOT, "src/indexer/indexMeta.ts"), "utf8");
    for (const file of FINGERPRINTED_FILES) {
      expect(source, `indexMeta should hash ${file}`).toContain(`"${file}"`);
    }
    for (const dir of FINGERPRINTED_DIRS) {
      expect(source, `indexMeta should hash ${dir}`).toContain(`"${dir}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Behavioural controls for the exemptions
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const FIXTURE = `class HttpRequestParser:
    def parseJsonBody(self):
        return 1


def computeTotalPrice(itemList):
    return 2
`;

async function makeIndexedRepo(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `m146-${label}-`));
  roots.push(root);
  await writeFile(path.join(root, "sample.py"), FIXTURE);
  await execFile("git", ["init", "-q", root]);
  await execFile("git", ["-C", root, "add", "-A"]);
  await execFile("git", [
    "-C", root, "-c", "user.email=m146@test", "-c", "user.name=m146", "commit", "-qm", "init",
  ]);
  await initRepo({ repoPath: root });
  return root;
}

/** The derived content an index run persists, as a comparable snapshot. */
function readDerivedIndex(root: string): string {
  const db = new Database(resolveIndexDbPath(root), { readonly: true });
  try {
    const fts = db.query(
      "SELECT symbol_id, local_name, fq_name, file_path FROM symbol_search_fts ORDER BY symbol_id",
    ).all();
    const files = db.query("SELECT id, path, language FROM files ORDER BY path").all();
    const symbols = db.query(
      "SELECT id, fq_name, kind, file_id FROM symbols ORDER BY id",
    ).all();
    const edges = db.query(
      "SELECT src_symbol_id, dst_symbol_id, edge_type FROM edges ORDER BY src_symbol_id, dst_symbol_id, edge_type",
    ).all();
    return JSON.stringify({ files, fts, symbols, edges });
  } finally {
    db.close();
  }
}

/** Append a harmless but real code change, so the file's content hash moves. */
async function withMutatedFile<T>(relativePath: string, run: () => Promise<T>): Promise<T> {
  const absolute = path.join(VTRACE_ROOT, relativePath);
  const original = await readFile(absolute, "utf8");
  try {
    await writeFile(absolute, `${original}\nexport const __m146CoverageProbe = "m146";\n`);
    return await run();
  } finally {
    await writeFile(absolute, original);
  }
}

describe("M146-A exemption behavioural controls", () => {
  for (const relativePath of Object.keys(ALLOWED_UNFINGERPRINTED)) {
    test(`changing ${relativePath} leaves fingerprints and index output unchanged`, async () => {
      const root = await makeIndexedRepo("exempt");
      const before = await computeIndexFingerprints();
      const derivedBefore = readDerivedIndex(root);

      const { after, derivedAfter } = await withMutatedFile(relativePath, async () => {
        const rebuilt = await makeIndexedRepo("exempt-after");
        return { after: await computeIndexFingerprints(), derivedAfter: readDerivedIndex(rebuilt) };
      });

      // Exempt means: this file cannot move the compatibility verdict…
      expect(after.indexer_fingerprint).toBe(before.indexer_fingerprint);
      expect(after.parser_fingerprint).toBe(before.parser_fingerprint);
      expect(after.schema_version).toBe(before.schema_version);
      expect(after.config_hash).toBe(before.config_hash);
      // …precisely because it cannot move what indexing persists.
      expect(derivedAfter).toBe(derivedBefore);
    });
  }
});
