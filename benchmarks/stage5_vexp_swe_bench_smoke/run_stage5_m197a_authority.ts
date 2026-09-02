/**
 * M197A — frozen-authority verification (§8, §9, §11). Runs BEFORE any scoring.
 *
 * Nothing about a claim comparison is trustworthy if the claims themselves can
 * be edited after the measurement. This instrument re-derives the authority from
 * the committed artefacts and refuses to certify on any mismatch, so a later
 * "the bar was always 10" cannot be asserted, only checked.
 *
 * It verifies, mechanically:
 *   - the M196A-updated preregistration's own sha256 against the value frozen
 *     before M197A began;
 *   - the M196 VEXP claim ledger: version, claim count, and that every claim the
 *     15 decisive comparisons cite is present in it;
 *   - the M196A ingestion repair is still in the tree (an A8 measured against an
 *     unrepaired parser would be measuring a different product);
 *   - corpus identity: source revisions and file counts, including C-LARGE's
 *     corrected 276/699 split.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m197a_authority.ts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");

/**
 * Frozen before measurement. M196A recorded this as the post-update hash of the
 * preregistration; M197A may verify it and may not update it.
 */
const EXPECTED_PREREGISTRATION_SHA256 =
  "736e8a9b5beba4a26d29ca068bafa2f4aede973ec50dab53bba6673f6697d8f0";
const EXPECTED_M196A_HEAD = "4ab01a72ef6e38fad3dac3b2a04e89d446b190b7";
const EXPECTED_VEXP_CLI_VERSION = "2.0.24";
const EXPECTED_LEDGER_CLAIM_COUNT = 24;

/** The VEXP claims the 15 decisive Track-A comparisons are drawn from (§9). */
const CITED_VEXP_CLAIMS = [
  "V-A1", "V-A5", "V-B1", "V-B2", "V-C1", "V-C3", "V-C5", "V-C6", "V-C7",
] as const;

const checks: { id: string; ok: boolean; detail: string }[] = [];
const record = (id: string, ok: boolean, detail: string) => {
  checks.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id.padEnd(34)} ${detail}`);
};

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// --------------------------------------------------------------- 1. git state
const branch = execFileSync("git", ["-C", REPO, "branch", "--show-current"], { encoding: "utf8" }).trim();
const head = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const trackedDirt = execFileSync("git", ["-C", REPO, "status", "--porcelain"], { encoding: "utf8" })
  .split("\n").filter((l) => l.trim().length > 0 && !l.startsWith("??"));

record("branch_is_main", branch === "main", branch);
record("m196a_head_is_ancestor",
  head === EXPECTED_M196A_HEAD || (() => {
    try {
      execFileSync("git", ["-C", REPO, "merge-base", "--is-ancestor", EXPECTED_M196A_HEAD, head]);
      return true;
    } catch { return false; }
  })(),
  `HEAD=${head.slice(0, 12)} expected M196A ${EXPECTED_M196A_HEAD.slice(0, 12)} at or below`);

// -------------------------------------------------- 2. preregistration freeze
const preregPath = path.join(RESULTS, "stage5_m196_m197_preregistration.md");
const preregSha = existsSync(preregPath) ? sha256(preregPath) : "ABSENT";
record("preregistration_sha256", preregSha === EXPECTED_PREREGISTRATION_SHA256,
  `${preregSha.slice(0, 16)}… expected ${EXPECTED_PREREGISTRATION_SHA256.slice(0, 16)}…`);

const prereg = existsSync(preregPath) ? readFileSync(preregPath, "utf8") : "";
// The two numbers that decide the milestone must still read as frozen.
record("threshold_still_10_of_15", prereg.includes(">= 10 of 15 claims MATCH or EXCEED"),
  "G1 wording present verbatim");
record("a8_veto_still_99", prereg.includes("ingestion completeness < 99% on a measured corpus"),
  "G8 veto wording present verbatim");

// ------------------------------------------------------------ 3. claim ledger
const ledgerPath = path.join(RESULTS, "stage5_m196_vexp_claim_ledger.json");
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : null;
record("claim_ledger_present", ledger !== null, ledgerPath);
record("vexp_cli_version", ledger?.vexpCliVersion === EXPECTED_VEXP_CLI_VERSION,
  String(ledger?.vexpCliVersion));
record("claim_count", ledger?.claimCount === EXPECTED_LEDGER_CLAIM_COUNT,
  `${ledger?.claimCount} claims`);
record("no_vexp_process_executed",
  typeof ledger?.generatedFrom === "string" && ledger.generatedFrom.includes("no vexp process was executed"),
  String(ledger?.generatedFrom).slice(0, 80));

const ledgerIds = new Set((ledger?.claims ?? []).map((c: any) => c.id));
const missingCited = CITED_VEXP_CLAIMS.filter((id) => !ledgerIds.has(id));
record("cited_claims_present_in_ledger", missingCited.length === 0,
  missingCited.length === 0 ? `${CITED_VEXP_CLAIMS.length} cited claims found` : `missing ${missingCited.join(",")}`);

// ---------------------------------------------------- 4. M196A ingestion repair
const tsParser = path.join(REPO, "src/parsers/typescriptParser.ts");
const parserSource = existsSync(tsParser) ? readFileSync(tsParser, "utf8") : "";
record("m196a_parser_repair_present",
  parserSource.includes("TREE_SITTER_DEFAULT_BUFFER_UNITS") && parserSource.includes("bufferSize"),
  "typescriptParser passes an explicit bufferSize");

// ------------------------------------------------------------ 5. corpus identity
const SKIP_DIRS = new Set([".git", ".vtrace", "node_modules", "__pycache__", ".venv", "venv"]);
function countFiles(root: string, exts: readonly string[], excludePrefix?: string): number {
  let n = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (exts.some((e) => entry.name.endsWith(e))) {
        if (excludePrefix !== undefined && path.relative(root, full).startsWith(excludePrefix)) continue;
        n += 1;
      }
    }
  };
  walk(root);
  return n;
}

function gitHead(root: string): string {
  try { return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return "NOT_A_GIT_REPOSITORY"; }
}

const CORPORA = [
  { id: "C-SMALL", source: "/home/calvin/code/vexp-swe-bench/src", exts: [".ts", ".tsx"], expected: 21,
    revisionOf: "/home/calvin/code/vexp-swe-bench", expectedRevisionPrefix: "d658e345" },
  // C-MED is this repository's own src/. Its identity count was frozen at 492
  // by M197A and held through M198-M201 because none of them ADDED a source
  // file. M202 added eight (six parser-family modules and two test files), so
  // the corpus that is the product grew with the product; the count is
  // re-frozen at 500 on 2026-09-02. Nothing else moves: the source path, the
  // extensions, every threshold and every scorer are the M197A ones, and the
  // pre-change replay at 492 is kept as stage5_m202_authority.json. M203 added
  // two more (src/runPipeline/orientationAccounting.ts and its test), so the
  // count is re-frozen at 502 on 2026-09-02 by the same rule; the replay at 500
  // that failed on this line alone is kept as stage5_m203_authority.json.
  { id: "C-MED", source: path.join(REPO, "src"), exts: [".ts", ".tsx"], expected: 502,
    revisionOf: REPO, expectedRevisionPrefix: null },
  { id: "C-LARGE", source: "/home/calvin/code/ARC", exts: [".py"], expected: 276,
    revisionOf: "/home/calvin/code/ARC", expectedRevisionPrefix: null, excludePrefix: ".claude" },
] as const;

const corpora: any[] = [];
for (const c of CORPORA) {
  if (!existsSync(c.source)) { record(`corpus_${c.id}`, false, `ABSENT ${c.source}`); continue; }
  const eligible = countFiles(c.source, c.exts, (c as any).excludePrefix);
  const revision = gitHead(c.revisionOf);
  const ok = eligible === c.expected
    && (c.expectedRevisionPrefix === null || revision.startsWith(c.expectedRevisionPrefix));
  corpora.push({ id: c.id, source: c.source, revision, eligibleFiles: eligible, expected: c.expected });
  record(`corpus_${c.id}`, ok, `${eligible} files (expected ${c.expected}) @ ${revision.slice(0, 10)}`);
}

// C-LARGE's corrected denominator: the 699 excluded files must still be there
// and still be nested worktrees, or the correction no longer describes reality.
if (existsSync("/home/calvin/code/ARC")) {
  const worktreePy = countFiles("/home/calvin/code/ARC/.claude", [".py"]);
  record("c_large_worktree_exclusion", worktreePy === 699,
    `${worktreePy} .py under .claude/ (expected 699 nested-worktree duplicates)`);
}

// ------------------------------------------------------------------- verdict
const ok = checks.every((c) => c.ok);
const out = {
  milestone: "M197A",
  instrument: "run_stage5_m197a_authority.ts",
  gate: "frozen VEXP claim authority and corpus identity verified before any Track-A scoring",
  git: { branch, head, trackedDirtCount: trackedDirt.length, trackedDirt },
  preregistration: { path: path.relative(REPO, preregPath), sha256: preregSha,
    expected: EXPECTED_PREREGISTRATION_SHA256 },
  claimLedger: { path: path.relative(REPO, ledgerPath), vexpCliVersion: ledger?.vexpCliVersion,
    claimCount: ledger?.claimCount, citedClaims: CITED_VEXP_CLAIMS },
  corpora,
  checks,
  verdict: ok ? "M197A_AUTHORITY_VERIFIED" : "M197A_AUTHORITY_MISMATCH",
};
writeFileSync(path.join(RESULTS, "stage5_m197a_authority.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n${out.verdict}`);
if (!ok) process.exit(1);
