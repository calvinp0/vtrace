/**
 * M200 — paired predecessor/candidate proof for the AST batch-warm change (§41, CLAUDE.md).
 *
 * The warm is a cache: it runs the same `PYTHON_AST_SCRIPT` over the same bytes
 * and produces the same ASTs, so declining to warm can change how long a run
 * takes and nothing else. That is an argument, not evidence, and a parser change
 * is exactly where an argument is not enough — every symbol, edge, call site and
 * search row downstream is derived from those ASTs.
 *
 * So both sides are built here, from source, in separate working copies of the
 * same immutable corpus, and compared over the FULL semantic projection
 * including `normalizedGraphHash`. The predecessor is named explicitly by commit
 * and its parser is checked out into place, rather than compared against a
 * stored golden whose provenance cannot be bound to it.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m200_warm_nochange.ts \
 *     [--predecessor <sha>] [--corpora C-MED,C-LARGE] [--scratch <dir>] [--out <name>]
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SKIP_DIRS, corpusSpecs, prepareCorpus } from "./m197aFixtures";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const PARSER_SOURCE = path.join(REPO, "src/parsers/pythonParser.ts");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
/** The commit whose parser is the declared predecessor: M200 before the warm fix. */
const PREDECESSOR = argOf("--predecessor", "0edb758f");
const ONLY = argOf("--corpora", "C-MED,C-LARGE").split(",").map((s) => s.trim());
const SCRATCH = argOf("--scratch", path.join(process.env.TMPDIR ?? "/tmp", "m200warm"));
const OUT = argOf("--out", "stage5_m200_warm_nochange.json");
mkdirSync(SCRATCH, { recursive: true });

const git = (...a: string[]) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8" }).trim();

/**
 * Index a corpus in a CHILD process, so the parser module the run uses is the
 * one on disk when the child starts. Swapping a module in this process would
 * leave the already-imported one in the module cache and compare a build against
 * itself.
 */
function buildInChild(work: string): { projectionHash: string; normalizedGraphHash: string } {
  const script = path.join(SCRATCH, "build.ts");
  writeFileSync(script, `
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { indexProject } from ${JSON.stringify(path.join(REPO, "src/indexer/indexProject.ts"))};
import { openIndexerDatabase } from ${JSON.stringify(path.join(REPO, "src/db/sqlite.ts"))};
import { fullSemanticProjection } from ${JSON.stringify(path.join(import.meta.dir, "m199Equivalence.ts"))};
const work = process.argv[2];
mkdirSync(path.join(work, ".vtrace"), { recursive: true });
const db = openIndexerDatabase(path.join(work, ".vtrace", "index.sqlite"));
await indexProject({ repoRoot: work, db, parserVersion: "builtin-parser-v1" });
const projection = fullSemanticProjection(db);
db.close();
console.log(JSON.stringify({
  projectionHash: createHash("sha256").update(JSON.stringify(projection.sections)).digest("hex"),
  normalizedGraphHash: projection.normalizedGraphHash,
}));
`);
  const out = execFileSync("bun", [script, work], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

const candidateParser = readFileSync(PARSER_SOURCE, "utf8");
const predecessorParser = git("show", `${PREDECESSOR}:src/parsers/pythonParser.ts`);
if (candidateParser === predecessorParser) {
  throw new Error("M200_NO_PARSER_DELTA: predecessor and candidate parsers are identical");
}

const corpora: unknown[] = [];
let mismatches = 0;
try {
  for (const spec of corpusSpecs(REPO).filter((s) => ONLY.includes(s.id))) {
    const source = prepareCorpus(spec, SCRATCH);
    if (source === null) { corpora.push({ id: spec.id, status: "SOURCE_ABSENT" }); continue; }

    const sides: Record<string, { projectionHash: string; normalizedGraphHash: string }> = {};
    for (const [side, parser] of [["predecessor", predecessorParser], ["candidate", candidateParser]] as const) {
      writeFileSync(PARSER_SOURCE, parser);
      const work = path.join(SCRATCH, `${side}-${spec.id}`);
      rmSync(work, { recursive: true, force: true });
      cpSync(source, work, { recursive: true, dereference: false,
        filter: (s) => !SKIP_DIRS.has(path.basename(s)) });
      sides[side] = buildInChild(work);
      rmSync(work, { recursive: true, force: true });
    }
    const identical = sides.predecessor!.projectionHash === sides.candidate!.projectionHash
      && sides.predecessor!.normalizedGraphHash === sides.candidate!.normalizedGraphHash;
    if (!identical) mismatches += 1;
    corpora.push({ id: spec.id, language: spec.language, identical, ...sides });
    console.log(`${identical ? "IDENTICAL" : "DIFFERENT"}  ${spec.id.padEnd(8)} `
      + `graph ${sides.candidate!.normalizedGraphHash.slice(0, 16)}…`);
  }
} finally {
  // The working tree must come back whatever happened above.
  writeFileSync(PARSER_SOURCE, candidateParser);
}

const verdict = mismatches === 0 ? "M200_WARM_CHANGE_IS_SEMANTICALLY_INERT" : "M200_WARM_CHANGE_ALTERS_THE_GRAPH";
writeFileSync(path.join(RESULTS, OUT), `${JSON.stringify({
  milestone: "M200", instrument: "run_stage5_m200_warm_nochange.ts",
  purpose: "paired predecessor/candidate graph identity across the AST batch-warm change",
  predecessorCommit: git("rev-parse", PREDECESSOR),
  candidateCommit: git("rev-parse", "HEAD"),
  candidateTreeDirty: git("status", "--porcelain").split("\n").filter((l) => l.trim() && !l.startsWith("??")),
  corpora, mismatches, verdict,
}, null, 2)}\n`);
console.log(`\n${verdict}`);
console.log(`wrote results/${OUT}`);
