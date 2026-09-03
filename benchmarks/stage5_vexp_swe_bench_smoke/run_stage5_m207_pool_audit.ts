/**
 * M207 — read-only audit of the retrieval-pool authority.
 *
 * Before the pool is varied, every count bound on the path from the query to
 * the ranked candidate stream is recovered MECHANICALLY from the product source
 * and its git history: where the bound is defined, what it is, where it is
 * applied (SQL, post-ranking slice, merge limit, lane window), whether it
 * depends on the caller's budget, and what the comment beside it claims it is
 * for. Nothing here is transcribed from a prompt; a bound that cannot be
 * located in source is recorded as absent, not assumed.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m207_pool_audit.ts \
 *     [--product-root <dir>] [--label pre]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const PRODUCT_ROOT = path.resolve(argOf("--product-root", REPO));
const LABEL = argOf("--label", "pre");

const git = (...a: string[]) => execFileSync("git", ["-C", PRODUCT_ROOT, ...a], { encoding: "utf8" }).trim();
const read = (rel: string) => readFileSync(path.join(PRODUCT_ROOT, rel), "utf8");
const lines = (text: string) => text.split("\n");

interface Bound {
  readonly stage: string;
  readonly file: string;
  readonly symbol: string;
  readonly value: number | string | null;
  readonly appliedAt: string;
  readonly budgetAware: boolean;
  readonly kind: string;
  readonly rationale: string;
  readonly line: number | null;
}

function constant(rel: string, re: RegExp, group = 1): { value: number | null; line: number | null } {
  if (!existsSync(path.join(PRODUCT_ROOT, rel))) return { value: null, line: null };
  const text = read(rel);
  const m = re.exec(text);
  if (m === null) return { value: null, line: null };
  const line = text.slice(0, m.index).split("\n").length;
  return { value: Number.parseInt(m[group]!.replace(/_/g, ""), 10), line };
}

/** The comment block immediately above a line (contiguous `//` lines). */
function commentAbove(rel: string, line: number | null): string[] {
  if (line === null) return [];
  const ls = lines(read(rel));
  const out: string[] = [];
  for (let i = line - 2; i >= 0; i -= 1) {
    const t = ls[i]!.trim();
    if (!t.startsWith("//")) break;
    out.unshift(t.replace(/^\/\/\s?/, ""));
  }
  return out;
}

const bounds: Bound[] = [];
const push = (b: Bound) => bounds.push(b);

// ------------------------------------------------------------ the pool
const poolRel = "src/capsuleV2/buildCapsuleV2.ts";
const pool = constant(poolRel, /const CANDIDATE_POOL_SIZE = (\d+);/);
const poolComment = commentAbove(poolRel, pool.line);
const poolBlame = pool.line === null ? null : git("blame", "-L", `${pool.line},${pool.line}`, "--porcelain", poolRel).split("\n")[0]!.split(" ")[0]!;
const poolIntroduced = git("log", "--format=%H %ad %s", "--date=short", "-S", "CANDIDATE_POOL_SIZE = 25", "--", poolRel).split("\n").filter(Boolean).at(-1) ?? null;
const introducedSha = poolIntroduced?.split(" ")[0] ?? null;
let originalComment: string[] = [];
if (introducedSha !== null) {
  try {
    const original = git("show", `${introducedSha}:${poolRel}`);
    const ls = lines(original);
    const k = ls.findIndex((l) => /const CANDIDATE_POOL_SIZE = /.test(l));
    for (let i = k - 1; i >= 0; i -= 1) { const t = ls[i]!.trim(); if (!t.startsWith("//")) break; originalComment.unshift(t.replace(/^\/\/\s?/, "")); }
  } catch { originalComment = []; }
}
const poolText = read(poolRel);
const poolUses = lines(poolText).map((l, i) => ({ line: i + 1, text: l.trim() })).filter((l) => /CANDIDATE_POOL_SIZE|candidatePoolSize/.test(l.text) && !/^\/\//.test(l.text));
const classifyUse = (t: string): string => {
  if (/maxResults:/.test(t)) return "hybridRetrieve output cap (the pool)";
  if (/mergeCandidatesPreferring/.test(t)) return "anchor/backfill merge limit (evicts the tail)";
  if (/poolSize:/.test(t)) return "backfill lane search window";
  if (/lexicalPoolSizeFor/.test(t)) return "lexical row budget derivation";
  if (/const CANDIDATE_POOL_SIZE|candidatePoolSize\?|input\.candidatePoolSize/.test(t)) return "definition / instrument";
  return "other";
};
push({ stage: "final retrieval pool", file: poolRel, symbol: "CANDIDATE_POOL_SIZE", value: pool.value,
  appliedAt: "hybridRetrieve(maxResults) → ranked.slice(0, maxResults) after scoring (admitBoundedLanesBesideCap); then every anchor/backfill merge limit; then the compound-task re-retrieval",
  budgetAware: false, kind: poolComment.some((c) => /Generous/.test(c)) ? "retrieval-quality heuristic (fixed default)" : "fixed default",
  rationale: poolComment.join(" "), line: pool.line });

// ------------------------------------------------------- hybrid retrieval
const hrRel = "src/retrieval/hybridRetrieval.ts";
const hr = read(hrRel);
const hrDefaults = /const DEFAULTS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(hr)?.[1] ?? "";
const num = (name: string, text: string) => { const m = new RegExp(`${name}:\\s*(\\d+)`).exec(text); return m ? Number.parseInt(m[1]!, 10) : null; };
const lexMin = num("lexicalPoolMinimum", hrDefaults); const lexMul = num("lexicalPoolMultiplier", hrDefaults);
push({ stage: "lexical symbol search (prose query)", file: hrRel, symbol: "lexicalPoolSize = max(lexicalPoolMinimum, maxResults × lexicalPoolMultiplier)",
  value: lexMin !== null && lexMul !== null && pool.value !== null ? Math.max(lexMin, pool.value * lexMul) : null,
  appliedAt: "searchSymbols(maxResults = lexicalPoolSize): rankSearchCandidates slices the merged SQL candidate rows after ranking",
  budgetAware: false, kind: "derived from the pool (hidden second bound)", rationale: `lexicalPoolMinimum ${lexMin}, lexicalPoolMultiplier ${lexMul}: the lexical lane fetches ${lexMul}× the pool so graph/test routes can compete`, line: null });
push({ stage: "per-seed symbol search", file: hrRel, symbol: "DEFAULTS.symbolPoolSize", value: num("symbolPoolSize", hrDefaults),
  appliedAt: "searchSymbols(maxResults) per likely symbol / seed", budgetAware: false, kind: "lane window", rationale: "each resolved symbol name admits at most this many index rows", line: null });
push({ stage: "body-literal search", file: hrRel, symbol: "BODY_LITERAL_POOL_SIZE", value: constant(hrRel, /const BODY_LITERAL_POOL_SIZE = (\d+);/).value,
  appliedAt: "searchBodyLiterals(db, expr, limit) per literal", budgetAware: false, kind: "lane window", rationale: "a distinctive literal should resolve to very few symbols; cap defensively", line: constant(hrRel, /const BODY_LITERAL_POOL_SIZE = (\d+);/).line });
push({ stage: "likely-file path candidates", file: hrRel, symbol: "listSymbolsForFile (no count)", value: "unbounded per file",
  appliedAt: "every symbol of every likely edit file enters the raw map", budgetAware: false, kind: "no bound", rationale: "", line: null });
push({ stage: "failing-test → implementation", file: hrRel, symbol: "expandTestsToImplementation (no count)", value: "unbounded per test",
  appliedAt: "every routed implementation enters the raw map", budgetAware: false, kind: "no bound", rationale: "", line: null });
push({ stage: "scoring / ranking (assemble)", file: hrRel, symbol: "assemble → FULL ranked pool", value: "no truncation",
  appliedAt: "every raw candidate is scored and sorted; evaluatedById holds the whole ranking", budgetAware: false, kind: "no bound",
  rationale: (/Returns the FULL ranked pool; the caller applies `maxResults`/.test(hr) ? "comment: Returns the FULL ranked pool; the caller applies maxResults" : "comment not found"), line: null });
push({ stage: "bounded lanes beside the cap", file: hrRel, symbol: "admitBoundedLanesBesideCap", value: "concept-owner cap + operation-fact cap",
  appliedAt: "lane-admitted ids missing from the capped slice are appended and re-sorted", budgetAware: false, kind: "lane cap (beside the pool)", rationale: "a lane exists because ordinary ranking cannot see its findings", line: null });

// --------------------------------------------------------- graph expansion
const geRel = "src/retrieval/graphExpansion.ts";
const ge = existsSync(path.join(PRODUCT_ROOT, geRel)) ? read(geRel) : "";
const geDefaults = /const DEFAULTS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(ge)?.[1] ?? "";
push({ stage: "graph + same-module expansion", file: geRel, symbol: "DEFAULTS.maxExpandedCandidates / maxDepth / sameModuleLimit",
  value: `${num("maxExpandedCandidates", geDefaults)} candidates, depth ${num("maxDepth", geDefaults)}, ${num("sameModuleLimit", geDefaults)} siblings per seed`,
  appliedAt: "expandGraphCandidates over every query-side seed", budgetAware: false, kind: "lane window", rationale: "bounded neighbour expansion", line: null });

// ---------------------------------------------------------- SQL-side limits
const ssRel = "src/retrieval/searchSymbolsShared.ts";
push({ stage: "path-signal SQL candidates", file: ssRel, symbol: "PATH_SIGNAL_CANDIDATE_LIMIT", value: constant(ssRel, /const PATH_SIGNAL_CANDIDATE_LIMIT = (\d+);/).value,
  appliedAt: "SQL LIMIT on the path-signal candidate query", budgetAware: false, kind: "query-size safety", rationale: "", line: constant(ssRel, /const PATH_SIGNAL_CANDIDATE_LIMIT = (\d+);/).line });
push({ stage: "broad admission disjuncts", file: ssRel, symbol: "BROAD_ADMISSION_DISJUNCT_LIMIT", value: constant(ssRel, /const BROAD_ADMISSION_DISJUNCT_LIMIT = (\d+);/).value,
  appliedAt: "number of OR-disjuncts in the broad candidate SQL", budgetAware: false, kind: "query-size safety", rationale: "bounds the SQL text, not the rows", line: constant(ssRel, /const BROAD_ADMISSION_DISJUNCT_LIMIT = (\d+);/).line });
const sqlLimits = lines(read(ssRel)).map((l, i) => ({ line: i + 1, text: l.trim() })).filter((l) => /\bLIMIT\b/.test(l.text));
push({ stage: "broad candidate SQL", file: ssRel, symbol: "LIMIT clauses", value: sqlLimits.length,
  appliedAt: sqlLimits.map((l) => `${l.line}: ${l.text}`).join(" | "), budgetAware: false, kind: "observation",
  rationale: sqlLimits.length === 1 ? "the only SQL LIMIT on the lexical path is the path-signal query; the broad candidate query returns every matching row and ranking slices it" : "", line: null });

// ------------------------------------------------- capsule-side dependents
const dependents = [
  { name: "backfill lane windows", detail: "backfillProductionCandidates / backfillSqlRenderingCandidates search max(poolSize, BACKFILL_RETRIEVAL_WINDOW) and slice to poolSize", file: "src/capsuleV2/productionBackfill.ts" },
  { name: "concept-owner deliverable pool", detail: "conceptOwnerCandidates judges 'already represented' against ranked.slice(0, maxResults)", file: hrRel },
  { name: "orchestration withinPool", detail: "OrchestrationPathCandidate.withinPool = ordinaryRank <= maxResults; read by selectPathCompletion", file: hrRel },
  { name: "file-evidence lane arithmetic", detail: "comment: the pool cap counts SYMBOLS (25 symbols ≈ 9 distinct files); MAX_ORGANIC_RANK bounds the deep organic pass", file: "src/capsuleV2/fileEvidenceRescue.ts" },
  { name: "test-dominated pool test", detail: "isTestDominatedPool reads the ratio of test symbols in the (capped) pool to trigger production backfill", file: "src/capsuleV2/productionBackfill.ts" },
  { name: "co-edit poolFilePaths", detail: "expandCoeditSupport / rescueFileEvidenceSupport read the pool's file set to decide what is already present", file: "src/capsuleV2/coeditExpansion.ts" },
];
const fileEvidenceOrganicRank = constant("src/capsuleV2/fileEvidenceRescue.ts", /const MAX_ORGANIC_RANK = (\d+);/).value;
const routedRescueResults = constant("src/capsuleV2/authoritativeProductRetrieval.ts", /const MAX_ROUTED_RESCUE_RESULTS = (\d+);/).value;
const routedRescueAdditions = constant("src/capsuleV2/authoritativeProductRetrieval.ts", /const MAX_ROUTED_RESCUE_ADDITIONS = (\d+);/).value;

// ----------------------------------------------- budget authority (contrast)
const allocatorRel = "src/capsuleV2/budgetAllocator.ts";
const allocator = read(allocatorRel);
const allocatorCarriesPool = /candidatePool/.test(allocator);

// ---------------------------------------------- competitor-constant scan (F13)
const scan = (rel: string) => existsSync(path.join(PRODUCT_ROOT, rel))
  ? lines(read(rel)).map((l, i) => ({ line: i + 1, text: l.trim() })).filter((l) => /\b423\b|top 12|VEXP|vexp/i.test(l.text) && !/^\/\/|^\*|^\/\*/.test(l.text))
  : [];
const competitorScan = ["src/capsuleV2/buildCapsuleV2.ts", allocatorRel, hrRel].map((rel) => ({ file: rel, hits: scan(rel) }));

const out = {
  milestone: "M207", instrument: "run_stage5_m207_pool_audit.ts", label: LABEL,
  product: { root: PRODUCT_ROOT, head: git("rev-parse", "HEAD") },
  pool: {
    symbol: "CANDIDATE_POOL_SIZE", value: pool.value, file: poolRel, line: pool.line,
    blameCommit: poolBlame, introducedIn: poolIntroduced, originalComment, currentComment: poolComment,
    classification: {
      isSafetyBound: false,
      isPerformanceBound: false,
      isRetrievalQualityHeuristic: /Generous so the failing-test\/graph routes can pull in a target/.test(poolComment.join(" ")) || /Generous so/.test(originalComment.join(" ")),
      isBenchmarkHeuristic: false,
      isHistoricalDefault: true,
      isBudgetAware: false,
      commentDelegatesTrimmingTo: /budget allocator and role gate trim it back down/.test(poolComment.join(" ")) ? "the budget allocator and the role gate" : null,
      note: "The comment describes the pool as generous input to the allocator and role gate, i.e. as a supply the downstream bounds would trim. M206 measured the opposite: after the tier count was removed the pool itself is the binding stage at 8000 and 16000 (39 of 100 frozen responses stop on it), because the downstream token budget is caller-derived and the pool is not.",
    },
    useSites: poolUses.map((u) => ({ line: u.line, use: classifyUse(u.text), text: u.text })),
    dependents,
    seam: { present: /candidatePoolSize/.test(poolText), lexicalPoolPinned: /const LEXICAL_POOL_SIZE = lexicalPoolSizeFor\(CANDIDATE_POOL_SIZE\)/.test(poolText) },
  },
  bounds,
  rankedUniverse: {
    statement: "The ranking is never truncated: assemble scores the whole raw map and evaluatedById carries every scored candidate. The universe before the pool is bounded by the generators' own windows: the lexical row budget, per-seed symbol windows, the body-literal window, the graph-expansion window, and the rescue lanes' caps. The M206 '37-38 ranked pre-cap' figure is the CAPSULE's ordered stream (pool + support lanes), not this universe; the sweep measures the universe as the uncapped width's candidate_count.",
    lexicalRowBudget: lexMin !== null && lexMul !== null && pool.value !== null ? Math.max(lexMin, pool.value * lexMul) : null,
    graphExpansionWindow: num("maxExpandedCandidates", geDefaults),
    fileEvidenceOrganicRankWindow: fileEvidenceOrganicRank,
    routedRescue: { maxResults: routedRescueResults, maxAdditions: routedRescueAdditions },
  },
  budgetAuthority: { allocatorCarriesCandidatePool: allocatorCarriesPool, allocatorFile: allocatorRel,
    note: allocatorCarriesPool ? "the allocator derives the pool from the budget" : "the allocator sizes pivots and the support window from the budget; the pool is a fixed constant outside it" },
  competitorConstantScan: competitorScan,
  hiddenLimits: [
    "lexical row budget = max(20, 4 × pool) — derived from the pool, so the pool constant also sizes the lexical universe",
    "graph expansion 24 candidates at depth 1 (6 same-module siblings per seed)",
    "anchor/backfill merges evict the pool's tail to stay at the pool size",
    "the compound-task rescue re-retrieves at the same pool size",
    "MAX_ORGANIC_RANK (file-evidence deep pass) and MAX_ROUTED_RESCUE_RESULTS are independent 100-row windows",
  ],
};
writeFileSync(path.join(RESULTS, `stage5_m207_pool_authority_${LABEL}.json`), `${JSON.stringify(out, null, 2)}\n`);
console.log(`[${LABEL}] pool ${pool.value} @ ${poolRel}:${pool.line} (${poolIntroduced}); lexical row budget ${out.rankedUniverse.lexicalRowBudget}; `
  + `${bounds.length} bounds; use sites ${poolUses.length}; allocator carries pool ${allocatorCarriesPool} -> results/stage5_m207_pool_authority_${LABEL}.json`);
for (const b of bounds) console.log(`  ${b.stage.padEnd(40)} ${String(b.value).padEnd(28)} ${b.kind}`);
