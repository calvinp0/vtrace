/**
 * M202 — mixed-language repository integration, incremental controls and
 * worktree/exclusion truth (§22, §34, §36, §37).
 *
 * A repository is assembled in scratch from every family's valid fixture (plus
 * one deep-family file each, a TOML document and files under ignored, vendored
 * and generated paths) and indexed through the PRODUCTION `indexProject`.
 * Registry wiring is therefore tested end to end, not per parser in isolation:
 *
 *   discovery      every expected family appears in `files`, exactly once per file
 *   invocation     `Parser.prototype.parse` fired for every tree-sitter family
 *   exclusions     ignored / vendor / generated / worktree paths never enter
 *   determinism    two cold indexes hash identically
 *   incremental    no-op, modify, add, delete, rename each compare equal to a
 *                  clean full index on the normalised graph
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m202_mixed_corpus.ts
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import Parser from "tree-sitter";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { Language } from "../../src/domain/types";
import { indexProject } from "../../src/indexer/indexProject";
import { normalizedGraphHash } from "../../src/indexer/normalizedGraph";
import { structuralFamilies } from "../../src/parsers/languageFamilies";

const RESULTS = path.join(import.meta.dir, "results");
const FIXTURES = path.join(import.meta.dir, "fixtures", "m202_language_families");
const SCRATCH = path.join(process.env.TMPDIR ?? "/tmp", "m202-mixed");

// ------------------------------------------------ parser-invocation witness
const invocationsByGrammar = new Map<string, number>();
const originalParse = Parser.prototype.parse;
Parser.prototype.parse = function patched(this: Parser, ...args: Parameters<typeof originalParse>) {
  const language = (this as any).getLanguage?.() ?? null;
  const key = language === null ? "unknown" : String(language.name ?? language.constructor?.name ?? "language");
  invocationsByGrammar.set(key, (invocationsByGrammar.get(key) ?? 0) + 1);
  return originalParse.apply(this, args);
} as typeof originalParse;

// ------------------------------------------------------------ build corpus
rmSync(SCRATCH, { recursive: true, force: true });
const repo = path.join(SCRATCH, "repo");
mkdirSync(path.join(repo, "src"), { recursive: true });
const expected = new Map<string, Language>();
for (const family of structuralFamilies()) {
  const dir = path.join(FIXTURES, family.language);
  const valid = readdirSync(dir).find((f) => f.startsWith("valid."))!;
  const rel = `src/${family.language}/${valid}`;
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  cpSync(path.join(dir, valid), path.join(repo, rel));
  expected.set(rel, family.language);
}
mkdirSync(path.join(repo, "src/deep"), { recursive: true });
writeFileSync(path.join(repo, "src/deep/app.py"), "# café\nclass App:\n    def run(self):\n        return 1\n");
writeFileSync(path.join(repo, "src/deep/app.ts"), "// café\nexport function run(): number { return 1; }\n");
writeFileSync(path.join(repo, "src/deep/fast.pyx"), "cdef class Fast:\n    def go(self):\n        return 1\n");
writeFileSync(path.join(repo, "pyproject.toml"), "[tool]\nname = \"m202\"\n");
expected.set("src/deep/app.py", Language.Python);
expected.set("src/deep/app.ts", Language.TypeScript);
expected.set("src/deep/fast.pyx", Language.Cython);
expected.set("pyproject.toml", Language.Toml);
// must NOT enter the index
mkdirSync(path.join(repo, "vendor/lib"), { recursive: true });
writeFileSync(path.join(repo, "vendor/lib/vendored.go"), "package v\nfunc Vendored() {}\n");
mkdirSync(path.join(repo, "node_modules/pkg"), { recursive: true });
writeFileSync(path.join(repo, "node_modules/pkg/index.js"), "function dep() {}\n");
mkdirSync(path.join(repo, "build"), { recursive: true });
writeFileSync(path.join(repo, "build/out.c"), "int generated(void) { return 0; }\n");
writeFileSync(path.join(repo, ".gitignore"), "generated/\n");
mkdirSync(path.join(repo, "generated"), { recursive: true });
writeFileSync(path.join(repo, "generated/gen.rs"), "pub fn generated() {}\n");
writeFileSync(path.join(repo, "secrets.yml"), "token: abc\n");
// a nested linked worktree of the same repository
execFileSync("git", ["init", "-q", repo]);
execFileSync("git", ["-C", repo, "add", "-A"]);
execFileSync("git", ["-C", repo, "-c", "user.email=m202@example", "-c", "user.name=m202", "commit", "-q", "-m", "fixture"]);
execFileSync("git", ["-C", repo, "worktree", "add", "-q", path.join(repo, ".claude/worktrees/wt"), "-b", "wt"]);
const excluded = ["vendor/lib/vendored.go", "node_modules/pkg/index.js", "build/out.c", "generated/gen.rs", "secrets.yml",
  ".claude/worktrees/wt/src/go/valid.go"];

/**
 * Copies for clean comparison carry neither `.git` nor the nested worktree: a
 * copied `.git` still lists the ORIGINAL worktree path, so the copy would index
 * the duplicate checkout the original correctly excludes, and the two graphs
 * would differ for a reason that is about git metadata, not the indexer.
 */
const copyFilter = (src: string) => !/\/(\.vtrace|\.git|\.claude)(\/|$)/u.test(src);

function coldIndex(root: string) {
  rmSync(path.join(root, ".vtrace"), { recursive: true, force: true });
  mkdirSync(path.join(root, ".vtrace"), { recursive: true });
  const db = openIndexerDatabase(path.join(root, ".vtrace", "index.sqlite"));
  return { db, run: () => indexProject({ repoRoot: root, db }) };
}

// ------------------------------------------------------------ cold index ×2
const a = coldIndex(repo);
const first = await a.run();
const hashA = normalizedGraphHash(a.db);
const filesA = (a.db.query("select path, language from files order by path").all() as { path: string; language: string }[]);
const symbolsA = (a.db.query("select f.language as language, count(*) as c from symbols s join files f on f.id = s.file_id group by f.language order by f.language").all() as { language: string; c: number }[]);
a.db.close();
const b = coldIndex(path.join(SCRATCH, "repo-b"));
cpSync(repo, path.join(SCRATCH, "repo-b"), { recursive: true, filter: copyFilter });
const second = await b.run();
const hashB = normalizedGraphHash(b.db);
b.db.close();

const discovered = new Map(filesA.map((f) => [f.path, f.language]));
const missing = [...expected.entries()].filter(([p, l]) => discovered.get(p) !== l).map(([p, l]) => `${p} expected ${l} got ${discovered.get(p) ?? "absent"}`);
const leaked = excluded.filter((p) => discovered.has(p));
const duplicates = filesA.map((f) => f.path).filter((p, i, all) => all.indexOf(p) !== i);
const statuses = Object.fromEntries([...new Set(first.files.map((f) => f.status))].map((s) => [s, first.files.filter((f) => f.status === s).length]));
const familiesDiscovered = [...new Set(filesA.map((f) => f.language))].sort();
const familiesExpected = [...new Set(expected.values())].sort();
const structuralInvoked = invocationsByGrammar.size;

// ------------------------------------------------------- incremental controls
interface Step { readonly name: string; readonly mutate: () => void }
const steps: Step[] = [
  { name: "noop", mutate: () => {} },
  { name: "modify", mutate: () => writeFileSync(path.join(repo, "src/go/valid.go"), `${readFileSync(path.join(repo, "src/go/valid.go"), "utf8")}\nfunc added() int { return 2 }\n`) },
  { name: "add", mutate: () => writeFileSync(path.join(repo, "src/rust/extra.rs"), "pub fn extra() {}\n") },
  { name: "delete", mutate: () => unlinkSync(path.join(repo, "src/lua/valid.lua")) },
  { name: "rename", mutate: () => renameSync(path.join(repo, "src/ruby/valid.rb"), path.join(repo, "src/ruby/renamed.rb")) },
];
const incremental: any[] = [];
{
  rmSync(path.join(repo, ".vtrace"), { recursive: true, force: true });
  mkdirSync(path.join(repo, ".vtrace"), { recursive: true });
  const db = openIndexerDatabase(path.join(repo, ".vtrace", "index.sqlite"));
  let snapshot = (await indexProject({ repoRoot: repo, db })).snapshot;
  for (const step of steps) {
    step.mutate();
    const result = await indexProject({ repoRoot: repo, db, previousSnapshot: snapshot, refreshMode: "auto" });
    snapshot = result.snapshot;
    const incrementalHash = normalizedGraphHash(db);
    const clean = coldIndex(path.join(SCRATCH, `clean-${step.name}`));
    rmSync(path.join(SCRATCH, `clean-${step.name}`), { recursive: true, force: true });
    cpSync(repo, path.join(SCRATCH, `clean-${step.name}`), { recursive: true, filter: copyFilter });
    const cleanRun = coldIndex(path.join(SCRATCH, `clean-${step.name}`));
    await cleanRun.run();
    const cleanHash = normalizedGraphHash(cleanRun.db);
    cleanRun.db.close();
    clean.db.close();
    incremental.push({ step: step.name, mode: result.performance?.mode ?? null, fallbackReason: result.performance?.fallbackReason ?? null,
      parsedFiles: result.performance?.parsedFiles ?? null, parseCacheHits: result.performance?.parseCacheHits ?? null,
      filesIndexed: result.totalFilesSuccessfullyIndexed, incrementalEqualsClean: incrementalHash === cleanHash });
  }
  db.close();
}

const out = {
  milestone: "M202", instrument: "run_stage5_m202_mixed_corpus.ts", scratch: SCRATCH,
  familiesExpected, familiesDiscovered,
  filesExpected: expected.size, filesDiscovered: filesA.length,
  statuses,
  symbolsByLanguage: Object.fromEntries(symbolsA.map((r) => [r.language, r.c])),
  parserInvocations: { grammarsInvoked: structuralInvoked, byGrammar: Object.fromEntries(invocationsByGrammar) },
  structuralFamiliesRegistered: structuralFamilies().length,
  missing, leaked, duplicates,
  determinism: { coldHashA: hashA, coldHashB: hashB, identical: hashA === hashB, filesA: first.totalFilesSuccessfullyIndexed, filesB: second.totalFilesSuccessfullyIndexed },
  incremental,
  verdict: missing.length === 0 && leaked.length === 0 && duplicates.length === 0 && hashA === hashB
    && incremental.every((s) => s.incrementalEqualsClean) && familiesDiscovered.length === familiesExpected.length
    ? "M202_MIXED_CORPUS_PASS" : "M202_MIXED_CORPUS_FAIL",
};
writeFileSync(path.join(RESULTS, "stage5_m202_mixed_corpus.json"), `${JSON.stringify(out, null, 2)}\n`);
const md = [`# M202 — mixed-language repository integration\n`,
  `${familiesDiscovered.length}/${familiesExpected.length} families discovered over ${filesA.length} files (${expected.size} expected); `
  + `tree-sitter grammars invoked ${structuralInvoked}; statuses ${JSON.stringify(statuses)}; missing ${missing.length}; leaked exclusions ${leaked.length}; `
  + `duplicates ${duplicates.length}; cold determinism ${hashA === hashB ? "identical" : "DIFFERENT"}.\n`,
  `| step | mode | fallback | parsed | cache hits | files | incremental = clean |`, `| --- | --- | --- | ---: | ---: | ---: | --- |`,
  ...incremental.map((s) => `| ${s.step} | ${s.mode} | ${s.fallbackReason ?? ""} | ${s.parsedFiles} | ${s.parseCacheHits} | ${s.filesIndexed} | ${s.incrementalEqualsClean ? "yes" : "NO"} |`),
  ``, `Verdict: \`${out.verdict}\``];
writeFileSync(path.join(RESULTS, "stage5_m202_mixed_corpus.md"), `${md.join("\n")}\n`);
console.log(md.join("\n"));
if (missing.length > 0) console.log("missing:", missing);
if (leaked.length > 0) console.log("leaked:", leaked);
console.log(`symbols by language: ${JSON.stringify(out.symbolsByLanguage)}`);
if (out.verdict !== "M202_MIXED_CORPUS_PASS") process.exit(1);
