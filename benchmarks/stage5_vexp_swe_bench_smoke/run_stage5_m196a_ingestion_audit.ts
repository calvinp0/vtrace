/**
 * M196A — ingestion authority audit (A8).
 *
 * M197's A8 veto asks a question no prior milestone asked: of the source files
 * a corpus actually contains, how many can the index represent? M196 answered it
 * with a bare parser loop whose `catch` discarded the exception, so it could
 * report a loss count but never a reason. This runs the AUTHORITATIVE product
 * path — `indexProject` — and keeps every reason.
 *
 * Two denominators are always reported: the raw source files on disk and the
 * product's own post-exclusion `filesEligible`. A repair that improves coverage
 * by shrinking the second one is visible as a gap between them (§8).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m196a_ingestion_audit.ts \
 *     [--repeats 3] [--out <dir>]
 */
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { indexProject } from "../../src/indexer/indexProject";
import { initializeSchema } from "../../src/db/schema";

const RESULTS = path.join(import.meta.dir, "results");
const SCRATCH = process.env.M196A_SCRATCH
  ?? "/tmp/claude-1000/-home-calvin-code-vtrace/4ce2f921-efa5-4b0b-a0b6-aa8c9ac200a6/scratchpad/m196a";

/** The three corpora frozen by the M197 preregistration, §1. */
const CORPORA = [
  { id: "C-SMALL", source: "/home/calvin/code/vexp-swe-bench/src", exts: [".ts", ".tsx"], language: "TypeScript" },
  { id: "C-MED", source: path.resolve(import.meta.dir, "../../src"), exts: [".ts", ".tsx"], language: "TypeScript" },
  { id: "C-LARGE", source: "/home/calvin/code/ARC", exts: [".py"], language: "Python" },
] as const;

const SKIP_DIRS = new Set([".git", ".vtrace", "node_modules", "__pycache__", ".venv", "venv"]);

/**
 * The raw denominator: every file on disk carrying an extension the corpus is
 * declared to be made of. Deliberately independent of the product's own
 * enumeration, because agreeing with the thing under test is not evidence.
 */
function sourceFilesOnDisk(root: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (exts.some((e) => entry.name.endsWith(e))) out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Directories the product's own scanner drops unconditionally, mirrored here so
 * an exclusion can be *justified* rather than merely observed.
 */
const PRODUCT_IGNORED_DIRECTORIES = new Set([
  ".git", ".vtrace", ".codex", "node_modules", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache", ".vite",
  ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  ".tox", ".eggs", "target", ".gradle", ".idea", ".vscode", ".vs", "vendor",
]);

/**
 * Which of the corpus's on-disk files git itself considers ignored. Asked of the
 * ORIGINAL checkout, because the read-only copy has no `.git` to answer with —
 * and asked of git rather than inferred, so the exclusion is the repository's
 * own declared policy and not this instrument's opinion.
 */
function gitIgnoredPaths(sourceRoot: string, relPaths: readonly string[]): Set<string> {
  if (!existsSync(path.join(sourceRoot, ".git"))) return new Set();
  const out = new Set<string>();
  const BATCH = 500;
  for (let i = 0; i < relPaths.length; i += BATCH) {
    const batch = relPaths.slice(i, i + BATCH);
    try {
      const stdout = execFileSync("git", ["-C", sourceRoot, "check-ignore", "--", ...batch], { encoding: "utf8" });
      for (const line of stdout.split("\n")) if (line.trim().length > 0) out.add(line.trim());
    } catch (error: any) {
      // exit 1 means "none of these are ignored"; anything else is a real failure.
      if (error?.status !== 1) throw error;
      const stdout = String(error?.stdout ?? "");
      for (const line of stdout.split("\n")) if (line.trim().length > 0) out.add(line.trim());
    }
  }
  return out;
}

/**
 * Deterministic reason vocabulary (§8). Every missing file gets exactly one, and
 * `OTHER` / `NOT_ENUMERATED_BY_PRODUCT_SCAN` are defects to be explained, never
 * buckets to hide in. Only the EXCLUDED_* and WORKTREE_* reasons are eligible to
 * leave the A8 denominator, and each is justified by a policy the repository or
 * the product declared independently of this measurement.
 */
const LEGITIMATE_EXCLUSIONS = new Set([
  "EXCLUDED_BY_POLICY_GITIGNORE",
  "EXCLUDED_BY_POLICY_DIRECTORY",
  "WORKTREE_EXCLUDED",
]);

function classifyMissing(
  relPath: string,
  status: string | undefined,
  errorMessage: string | undefined,
  charLength: number | null,
  gitIgnored: ReadonlySet<string>,
  nestedWorktreeRoots: readonly string[],
): string {
  if (status === "unregistered_language" || status === "unsupported_language") return "UNSUPPORTED_SYNTAX";
  if (status === "read_failed") return "READ_FAILURE";
  if (status === "persistence_failed") return "PERSISTENCE_FAILURE";
  if (status === "parse_failed") {
    if (errorMessage?.includes("Invalid argument") && charLength !== null && charLength > 32767) return "SIZE_BOUNDARY";
    return "PARSER_FAILURE";
  }
  if (status === undefined) {
    if (nestedWorktreeRoots.some((r) => relPath === r || relPath.startsWith(`${r}/`))) return "WORKTREE_EXCLUDED";
    if (gitIgnored.has(relPath)) return "EXCLUDED_BY_POLICY_GITIGNORE";
    if (relPath.split("/").some((seg) => PRODUCT_IGNORED_DIRECTORIES.has(seg))) return "EXCLUDED_BY_POLICY_DIRECTORY";
    return "NOT_ENUMERATED_BY_PRODUCT_SCAN";
  }
  return "OTHER";
}

interface RunOutcome {
  represented: string[];
  missing: { path: string; reason: string; status: string | null; chars: number | null; error: string | null }[];
  eligibleProduct: number;
  productCoverage: { filesEligible: number; filesIndexed: number; filesFailed: number; filesSkipped: number; complete: boolean; failedLanguages: readonly string[] };
  totalSymbols: number;
  totalRelationships: number;
  elapsedMs: number;
}

async function indexOnce(
  workRoot: string,
  onDisk: readonly string[],
  gitIgnored: ReadonlySet<string>,
  nestedWorktreeRoots: readonly string[],
): Promise<RunOutcome> {
  const vtrace = path.join(workRoot, ".vtrace");
  rmSync(vtrace, { recursive: true, force: true });
  mkdirSync(vtrace, { recursive: true });
  const db = new Database(path.join(vtrace, "index.sqlite"));
  initializeSchema(db);
  const started = performance.now();
  const result = await indexProject({ repoRoot: workRoot, db });
  const elapsedMs = performance.now() - started;

  const byPath = new Map(result.files.map((f: any) => [f.path, f]));
  const represented: string[] = [];
  const missing: RunOutcome["missing"] = [];
  for (const rel of onDisk) {
    const summary: any = byPath.get(rel);
    if (summary?.status === "indexed") { represented.push(rel); continue; }
    const abs = path.join(workRoot, rel);
    const chars = existsSync(abs) ? readFileSync(abs, "utf8").length : null;
    const error = summary?.error?.message ?? null;
    missing.push({
      path: rel,
      reason: classifyMissing(rel, summary?.status, error ?? undefined, chars, gitIgnored, nestedWorktreeRoots),
      status: summary?.status ?? null,
      chars,
      error: error === null ? null : String(error).slice(0, 200),
    });
  }
  db.close();
  return {
    represented: represented.sort(),
    missing: missing.sort((a, b) => a.path.localeCompare(b.path)),
    eligibleProduct: result.coverage.filesEligible,
    productCoverage: { ...result.coverage },
    totalSymbols: result.totalSymbols,
    totalRelationships: result.totalRelationships,
    elapsedMs,
  };
}

const repeats = Number(process.argv[process.argv.indexOf("--repeats") + 1] ?? 3) || 3;
mkdirSync(SCRATCH, { recursive: true });

const report: any[] = [];
for (const corpus of CORPORA) {
  if (!existsSync(corpus.source)) {
    report.push({ id: corpus.id, status: "CORPUS_ABSENT", source: corpus.source });
    continue;
  }
  // Copied read-only: neither ARC nor the competitor checkout may gain a .vtrace
  // directory as a side effect of being measured.
  const work = path.join(SCRATCH, corpus.id);
  rmSync(work, { recursive: true, force: true });
  cpSync(corpus.source, work, { recursive: true, dereference: false,
    filter: (src) => !SKIP_DIRS.has(path.basename(src)) });
  const onDisk = sourceFilesOnDisk(work, corpus.exts);

  const gitIgnored = gitIgnoredPaths(corpus.source, onDisk);
  const nestedWorktreeRoots = (() => {
    if (!existsSync(path.join(corpus.source, ".git"))) return [] as string[];
    try {
      return execFileSync("git", ["-C", corpus.source, "worktree", "list", "--porcelain"], { encoding: "utf8" })
        .split("\n").filter((l) => l.startsWith("worktree "))
        .map((l) => path.relative(corpus.source, l.slice("worktree ".length).trim()))
        .filter((r) => r.length > 0 && !r.startsWith(".."));
    } catch { return [] as string[]; }
  })();

  const runs: RunOutcome[] = [];
  for (let i = 0; i < repeats; i += 1) runs.push(await indexOnce(work, onDisk, gitIgnored, nestedWorktreeRoots));

  const first = runs[0]!;
  const key = (r: RunOutcome) => JSON.stringify({ rep: r.represented, miss: r.missing.map((m) => [m.path, m.reason]) });
  const symdiff = runs.map((r) => key(r)).filter((k) => k !== key(first)).length;
  const reasons: Record<string, number> = {};
  for (const m of first.missing) reasons[m.reason] = (reasons[m.reason] ?? 0) + 1;
  const legitimatelyExcluded = first.missing.filter((m) => LEGITIMATE_EXCLUSIONS.has(m.reason));
  const unexplainedMissing = first.missing.filter((m) => !LEGITIMATE_EXCLUSIONS.has(m.reason));
  // A8's denominator. Files leave it only via a reason the repository or the
  // product declared on its own; every removal is itemised below so a shrinking
  // denominator can never masquerade as rising coverage (§8).
  const eligible = onDisk.length - legitimatelyExcluded.length;

  report.push({
    id: corpus.id,
    language: corpus.language,
    source: corpus.source,
    sourceFilesOnDisk: onDisk.length,
    legitimatelyExcluded: legitimatelyExcluded.length,
    eligible,
    represented: first.represented.length,
    unexplainedMissing: unexplainedMissing.length,
    coveragePercent: eligible > 0 ? +(100 * first.represented.length / eligible).toFixed(2) : null,
    coverageAgainstRawDisk: +(100 * first.represented.length / onDisk.length).toFixed(2),
    filesEligibleProduct: first.eligibleProduct,
    // The product enumerates every language it supports, not only the extension
    // this corpus is declared to be made of, so a gap here is expected and must
    // be in the safe direction: the product seeing MORE, never fewer.
    productCoverage: first.productCoverage,
    denominatorAgreesWithProduct: first.eligibleProduct === eligible,
    missingReasons: reasons,
    exclusionJustification: Object.fromEntries(
      [...new Set(legitimatelyExcluded.map((m) => m.reason))]
        .map((r) => [r, { count: legitimatelyExcluded.filter((m) => m.reason === r).length,
                          examples: legitimatelyExcluded.filter((m) => m.reason === r).slice(0, 3).map((m) => m.path) }]),
    ),
    unexplainedMissingFiles: unexplainedMissing.slice(0, 50),
    filesOver32767: onDisk.filter((f) => readFileSync(path.join(work, f), "utf8").length > 32767).length,
    eligibleFilesOver32767: onDisk.filter((f) => !legitimatelyExcluded.some((m) => m.path === f))
      .filter((f) => readFileSync(path.join(work, f), "utf8").length > 32767).length,
    totalSymbols: first.totalSymbols,
    totalRelationships: first.totalRelationships,
    determinism: {
      repeats,
      nonIdenticalRuns: symdiff,
      symbolCounts: runs.map((r) => r.totalSymbols),
      relationshipCounts: runs.map((r) => r.totalRelationships),
      symbolCountsIdentical: new Set(runs.map((r) => r.totalSymbols)).size === 1,
    },
    timingsMs: runs.map((r) => Math.round(r.elapsedMs)),
  });
  const r = report.at(-1)!;
  console.log(`${corpus.id.padEnd(8)} represented ${String(r.represented).padStart(5)}/${String(r.eligible).padEnd(5)} eligible = ${String(r.coveragePercent).padStart(6)}%  (onDisk ${r.sourceFilesOnDisk}, excluded ${r.legitimatelyExcluded})  unexplained=${r.unexplainedMissing}  nondet=${symdiff}  reasons=${JSON.stringify(reasons)}`);
}

const a8 = report.every((r) => r.status !== "CORPUS_ABSENT" && (r.coveragePercent ?? 0) >= 99
  && r.unexplainedMissing === 0 && r.determinism.nonIdenticalRuns === 0);
const out = {
  milestone: "M196A",
  instrument: "run_stage5_m196a_ingestion_audit.ts",
  gate: "M197 Track A / A8 ingestion completeness >= 99% on every decisive corpus",
  repeats,
  corpora: report,
  verdict: a8 ? "M197_A8_INGESTION_READY" : "M197_A8_INGESTION_NOT_READY",
};
writeFileSync(path.join(RESULTS, "stage5_m196a_ingestion_audit.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n${out.verdict}`);
