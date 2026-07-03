// Stage 5 M100 — candidate-pool recall gap audit (pre-change).
//
// Driven by the FROZEN M99 scoreboard detail. M99 closed the import-relation
// gap and issued: "candidate recall is the binding constraint — 31/42 hidden
// gold files never enter the retrieval pool at all". This audit asks, for every
// remaining hidden gold file, WHY it never enters the pool and whether a
// bounded FILE-LEVEL EVIDENCE lane (exact issue-text literals resolved against
// repo file paths / raw source text) could recover it without broad fuzzy
// expansion:
//
//   1. pool fate on rebuild (in capsule / discarded / absent / not indexed);
//   2. extended-pool probe: is the file reachable by the EXISTING generators at
//      a deeper maxResults (seam C: ranking/pool-size) or truly unreachable
//      (seam B/E: no generator has file-level text evidence);
//   3. evidence-shape scan: which exact issue-text terms (backticked, quoted,
//      error fragments, code tokens, identifiers) appear verbatim in the hidden
//      file's raw source text or path, at what repo-wide ambiguity, and whether
//      the match lies OUTSIDE every indexed symbol body (i.e. file-level text
//      the symbol index cannot see);
//   4. noise simulation: over ALL scored cases, what would each evidence shape
//      admit under ambiguity/length/source-only gates (gold vs non-gold), so
//      the lane's gates are chosen from measured precision, not hope.
//
// The derived task (title + first substantive sentence, <=360 chars) is what
// the product sees; terms found only in the FULL problem statement are counted
// separately as out-of-reach diagnostics. Gold labels the OUTPUT only; capsule
// rebuilds and the noise simulation see just the derived task.
//
// Split discipline: per-case file detail is emitted for DEV cases only;
// holdout cases contribute aggregate counters and nothing else.
//
// NO Claude, NO Docker, NO agent run, NO API calls, NO live network.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { planIntent } from "../../src/capsuleV2/intent";
import { isGenericInfraFile, isVendoredOrGenerated } from "../../src/capsuleV2/graphNeighborAnchoring";
import { listAllFilePaths } from "../../src/db/repositories/filesRepository";
import { listSymbolsForFile } from "../../src/db/repositories/symbolsRepository";
import { extractBodyLiterals } from "../../src/indexer/extractBodyLiterals";
import { hybridRetrieve } from "../../src/retrieval/hybridRetrieval";
import { shapeSweQuery } from "../../src/capsule/sweQueryShaping";

import {
  deriveTaskFromProblemStatement,
  loadSweBench,
} from "./build_stage5_retrieval_fixture";
import { fileMatches, normalizeFilePath } from "./run_stage5_retrieval_eval";

const DEFAULT_DATA = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
const RESULTS_ROOT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");
const WS_ROOT = path.join(RESULTS_ROOT, "workspaces");
const INDEX_RELPATH = path.join(".vtrace", "index.sqlite");
const CLEAN_WS_ROOTS = ["expanded", "cross_repo"] as const;
const CAPSULE_BUDGET = 8000;
const EXTENDED_POOL_SIZE = 400;
const MAX_CONTENT_BYTES = 512 * 1024;

function resolveCleanWorkspace(instanceId: string): string | null {
  for (const root of CLEAN_WS_ROOTS) {
    const ws = path.join(WS_ROOT, root, instanceId);
    if (existsSync(path.join(ws, INDEX_RELPATH))) return ws;
  }
  return null;
}

// --- evidence extraction --------------------------------------------------------

type EvidenceShape =
  | "backticked_span"
  | "quoted_string"
  | "error_fragment"
  | "exception_name"
  | "code_token"
  | "snake_identifier"
  | "camel_identifier"
  | "dunder_identifier"
  | "dotted_path";

interface EvidenceTerm {
  readonly term: string;
  readonly shape: EvidenceShape;
  /** Visible to the product (derived task) or only in the full statement. */
  readonly in_derived_task: boolean;
}

// Words too common to ever be file-level evidence alone (mirrors the direct-
// evidence stoplist spirit; the audit measures rather than assumes, but pure
// stop-words would only add noise rows).
const GENERIC_EVIDENCE = new Set([
  "field", "query", "model", "object", "type", "value", "request", "response",
  "parser", "manager", "handler", "error", "warning", "exception", "message",
  "default", "options", "instance", "example", "return", "import", "static",
]);

function extractEvidenceTerms(derivedTask: string, fullStatement: string): EvidenceTerm[] {
  const out: EvidenceTerm[] = [];
  const seen = new Set<string>();
  const push = (raw: string, shape: EvidenceShape, inDerived: boolean): void => {
    const term = raw.trim();
    if (term.length < 4 || term.length > 160) return;
    if (GENERIC_EVIDENCE.has(term.toLowerCase())) return;
    const key = `${shape}|${term}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ term, shape, in_derived_task: inDerived });
  };

  const scan = (text: string, inDerived: boolean): void => {
    const noUrls = text.replace(/\bhttps?:\/\/\S+/gi, " ");
    for (const m of noUrls.matchAll(/`([^`\n]{4,120})`/g)) push(m[1]!, "backticked_span", inDerived);
    for (const m of noUrls.matchAll(/(['"])((?:\\.|(?!\1).){6,160})\1/g)) {
      push(m[2]!, "quoted_string", inDerived);
    }
    for (const m of noUrls.matchAll(/\b([A-Z][A-Za-z]*(?:Error|Exception|Warning))\b(?::[ \t]*([^\n]{8,140}))?/g)) {
      push(m[1]!, "exception_name", inDerived);
      if (m[2] !== undefined) push(m[2].replace(/["'`]+$/, ""), "error_fragment", inDerived);
    }
    for (const lit of extractBodyLiterals(noUrls)) {
      if (lit.kind === "code") push(lit.text, "code_token", inDerived);
    }
    for (const m of noUrls.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
      if (m[0].length >= 6) push(m[0], "snake_identifier", inDerived);
    }
    for (const m of noUrls.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) {
      push(m[0], "camel_identifier", inDerived);
    }
    for (const m of noUrls.matchAll(/\b__\w{2,}__\b/g)) push(m[0], "dunder_identifier", inDerived);
    for (const m of noUrls.matchAll(/\b[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*){1,}\b/g)) {
      const segments = m[0].split(".");
      if (segments.length >= 2 && segments.every((s) => s.length >= 2)) {
        push(m[0], "dotted_path", inDerived);
      }
    }
  };

  // Derived-task terms first (product-visible), then full-statement extras.
  scan(derivedTask, true);
  scan(fullStatement, false);
  return out;
}

// --- file classification ----------------------------------------------------------

type FileKind = "source" | "test" | "docs_examples" | "generated_vendored" | "other";

function classifyFile(p: string): FileKind {
  if (/(^|\/)tests?\//.test(p) || /(^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(p)) return "test";
  if (/(^|\/)(docs?|examples?|tutorials?)\//.test(p) || /\.(rst|md|txt)$/.test(p)) return "docs_examples";
  if (isVendoredOrGenerated(p)) return "generated_vendored";
  return p.endsWith(".py") ? "source" : "other";
}

// --- workspace content map ---------------------------------------------------------

interface RepoContent {
  /** Indexed .py paths -> raw content (capped; oversize files map to null). */
  readonly byPath: Map<string, string | null>;
}

function loadRepoContent(workspace: string, allPaths: readonly string[]): RepoContent {
  const byPath = new Map<string, string | null>();
  for (const p of allPaths) {
    if (!p.endsWith(".py")) continue;
    try {
      const statContent = readFileSync(path.join(workspace, p), "utf8");
      byPath.set(p, statContent.length > MAX_CONTENT_BYTES ? null : statContent);
    } catch {
      byPath.set(p, null);
    }
  }
  return { byPath };
}

// --- per-term repo scan ---------------------------------------------------------------

interface TermScan {
  readonly term: string;
  readonly shape: EvidenceShape;
  readonly in_derived_task: boolean;
  readonly content_match_count: number;
  readonly content_matches_sample: string[];
  readonly basename_match_count: number;
}

function scanTerm(term: EvidenceTerm, repo: RepoContent): TermScan {
  const matches: string[] = [];
  let count = 0;
  for (const [p, content] of repo.byPath) {
    if (content === null) continue;
    if (!content.includes(term.term)) continue;
    count += 1;
    if (matches.length < 8) matches.push(p);
    if (count > 60) break; // hub term; exact count beyond this is irrelevant
  }
  const stem = term.term.replace(/\.py$/, "");
  let basenames = 0;
  for (const p of repo.byPath.keys()) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    if (base === `${stem}.py`) basenames += 1;
  }
  return {
    term: term.term,
    shape: term.shape,
    in_derived_task: term.in_derived_task,
    content_match_count: count,
    content_matches_sample: matches,
    basename_match_count: basenames,
  };
}

// --- audit types ------------------------------------------------------------------

interface HiddenFileHit {
  readonly term: string;
  readonly shape: EvidenceShape;
  readonly in_derived_task: boolean;
  readonly repo_content_match_count: number;
  readonly matched_in_path: boolean;
  /** The verbatim match lies outside every indexed symbol byte range. */
  readonly outside_symbol_ranges: boolean;
}

interface HiddenFileAudit {
  readonly hidden_path: string;
  readonly pool_fate: string;
  readonly file_kind: FileKind;
  readonly size_bytes: number;
  readonly indexed_symbol_count: number;
  /** Rank (1-based) of the file in the extended (400) organic pool; null if absent. */
  readonly extended_pool_rank: number | null;
  /** 1-based rank among DISTINCT FILES of the extended organic pool. */
  readonly extended_pool_file_rank: number | null;
  readonly hits: HiddenFileHit[];
  readonly derived_task_hit_count: number;
  readonly full_only_hit_count: number;
}

interface SimulatedFileCandidate {
  readonly path: string;
  readonly term: string;
  readonly shape: EvidenceShape;
  readonly ambiguity: number;
  readonly file_kind: FileKind;
  readonly term_length: number;
  readonly is_gold: boolean;
}

// A file the ORGANIC generators reached (extended probe) but the actual pool
// does not hold: rank <= 25 means the injection merges evicted it from the
// initial retrieval pool; deeper ranks never entered. The rescue simulation
// measures what admitting these under rank/evidence gates would cost.
interface OrganicRescueCandidate {
  readonly path: string;
  readonly rank: number;
  /** 1-based rank among DISTINCT FILES of the extended organic pool. The pool
   * cap counts symbols (25 symbols ≈ 9 files), so file rank is the honest
   * measure of how close retrieval came to surfacing this file. */
  readonly file_rank: number;
  readonly file_kind: FileKind;
  readonly is_gold: boolean;
  /** Minimum repo-wide ambiguity of a derived-task term matching this file's text (null: none). */
  readonly derived_evidence_min_ambiguity: number | null;
  readonly derived_evidence_shapes: EvidenceShape[];
}

interface CaseAudit {
  readonly instance_id: string;
  readonly repo: string;
  readonly cohort: "dev" | "holdout";
  readonly outcome: string;
  readonly multi_file: boolean;
  readonly hidden_gold_count: number;
  readonly hidden: HiddenFileAudit[];
  readonly derived_task_term_count: number;
  readonly simulated_candidates: SimulatedFileCandidate[];
  readonly organic_rescue_candidates: OrganicRescueCandidate[];
}

interface DetailRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly generation_status: string;
  readonly outcome: string | null;
  readonly gold: { scored_files: string[]; multi_file: boolean };
  readonly capsule: { capsule_files: string[] } | null;
  readonly file_metrics: unknown | null;
}

// Failing-test extraction and symbol seeding, mirrored from buildCapsuleV2 (both
// private there) so the extended-pool probe runs the SAME organic generators.
function extractFailingTests(task: string): string[] {
  const ids = new Set<string>();
  for (const m of task.matchAll(/\b[\w./-]+\.py::[\w:]+/g)) ids.add(m[0]);
  for (const m of task.matchAll(/\b[\w.]+\.[A-Z]\w*\.test_\w+\b/g)) ids.add(m[0]);
  return [...ids];
}

function deriveSymbolSeeds(shaped: ReturnType<typeof shapeSweQuery>): string[] {
  const seeds = new Set<string>();
  for (const identifier of shaped.identifiers) {
    if (/Test/.test(identifier) && /^[A-Z]/.test(identifier)) {
      const subject = identifier.replace(/^Test(?=[A-Z])/, "").replace(/(?:TestCase|Tests|Test)$/, "");
      if (subject.length >= 3) seeds.add(subject);
    } else if (!/^test[_A-Z]/.test(identifier)) {
      seeds.add(identifier);
    }
  }
  return [...seeds];
}

async function main(): Promise<void> {
  const detail = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m99_deterministic_scoreboard.detail.json"), "utf8"),
  ) as { rows: DetailRow[] };
  const split = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m95_dev_holdout_split.json"), "utf8"),
  ) as { dev: string[]; holdout: string[] };
  const devSet = new Set(split.dev);
  const swe = await loadSweBench(DEFAULT_DATA);

  const scoredRows = detail.rows.filter(
    (r) => r.generation_status === "scored" && r.capsule !== null && r.file_metrics !== null,
  );

  const cases: CaseAudit[] = [];
  for (const row of scoredRows) {
    const cohort: "dev" | "holdout" = devSet.has(row.instance_id) ? "dev" : "holdout";
    const workspace = resolveCleanWorkspace(row.instance_id);
    const instance = swe.get(row.instance_id);
    if (workspace === null || instance === undefined) continue;

    const db = openIndexerDatabase(path.join(workspace, INDEX_RELPATH));
    const allPaths = listAllFilePaths(db).map((p) => normalizeFilePath(p));
    const repo = loadRepoContent(workspace, allPaths);
    const resolveIndexPath = (gold: string): string | null =>
      allPaths.find((p) => fileMatches(gold, p)) ?? null;

    const task = deriveTaskFromProblemStatement(instance.problem_statement);
    const result = buildCapsuleV2({
      db, repoRoot: workspace, task, intent: CapsuleIntent.Debug, maxTokens: CAPSULE_BUDGET,
    });
    const capsulePaths = [...new Set([...result.pivots, ...result.support].map((it) => it.path))];
    const poolPaths = new Set([...capsulePaths, ...result.discarded.map((d) => d.path)]);

    // Extended organic pool probe: the same generators, ranked much deeper.
    const shaped = shapeSweQuery({ problemStatement: task, failToPass: extractFailingTests(task) });
    const plan = planIntent(CapsuleIntent.Debug, task, shaped);
    const extended = hybridRetrieve(db, {
      query: shaped.query,
      shaped,
      taskText: task,
      weights: plan.weights,
      symbolSeeds: deriveSymbolSeeds(shaped),
      maxResults: EXTENDED_POOL_SIZE,
    });
    const extendedRankByFile = new Map<string, number>();
    const extendedFileRank = new Map<string, number>();
    extended.candidates.forEach((c, i) => {
      if (!extendedRankByFile.has(c.filePath)) {
        extendedRankByFile.set(c.filePath, i + 1);
        extendedFileRank.set(c.filePath, extendedFileRank.size + 1);
      }
    });

    const hiddenGold = row.gold.scored_files.filter(
      (g) => !capsulePaths.some((c) => fileMatches(g, c)),
    );

    const terms = extractEvidenceTerms(task, instance.problem_statement);
    const derivedTerms = terms.filter((t) => t.in_derived_task);

    // Per-term repo scans, computed lazily and cached (a term is scanned once).
    const scanCache = new Map<string, TermScan>();
    const scanned = (t: EvidenceTerm): TermScan => {
      const key = `${t.shape}|${t.term}`;
      const cached = scanCache.get(key);
      if (cached !== undefined) return cached;
      const s = scanTerm(t, repo);
      scanCache.set(key, s);
      return s;
    };

    const hidden: HiddenFileAudit[] = [];
    for (const hiddenGoldFile of hiddenGold) {
      const hiddenPath = resolveIndexPath(hiddenGoldFile);
      if (hiddenPath === null) {
        hidden.push({
          hidden_path: hiddenGoldFile, pool_fate: "not_in_index", file_kind: classifyFile(hiddenGoldFile),
          size_bytes: 0, indexed_symbol_count: 0, extended_pool_rank: null,
          extended_pool_file_rank: null, hits: [],
          derived_task_hit_count: 0, full_only_hit_count: 0,
        });
        continue;
      }
      const hiddenFileRank = extendedFileRank.get(hiddenPath) ?? null;
      const discard = result.discarded.find((d) => fileMatches(hiddenGoldFile, d.path));
      const poolFate = capsulePaths.some((p) => fileMatches(hiddenGoldFile, p))
        ? "in_capsule_on_rebuild"
        : discard !== undefined
          ? `discarded: ${discard.discard_reason}`
          : "absent_from_pool";

      let content = repo.byPath.get(hiddenPath) ?? null;
      if (content === null && !hiddenPath.endsWith(".py")) {
        try {
          content = readFileSync(path.join(workspace, hiddenPath), "utf8");
        } catch {
          content = null;
        }
      }
      const symbols = listSymbolsForFile(db, hiddenPath);
      const contentBytes = content === null ? null : Buffer.from(content, "utf8");

      const hits: HiddenFileHit[] = [];
      for (const term of terms) {
        const inContent = content !== null && content.includes(term.term);
        const base = hiddenPath.slice(hiddenPath.lastIndexOf("/") + 1);
        const stem = base.replace(/\.py$/, "");
        const inPath = term.term === base || term.term === stem
          || term.term.replace(/\.py$/, "") === stem
          || (term.term.includes("/") && hiddenPath.endsWith(term.term))
          || (term.shape === "dotted_path" && hiddenPath.endsWith(`${term.term.replace(/\./g, "/")}.py`));
        if (!inContent && !inPath) continue;
        // Does at least one verbatim occurrence lie OUTSIDE every indexed symbol
        // body (module level / comments / constants — invisible to symbol search)?
        let outside = false;
        if (inContent && contentBytes !== null) {
          const needle = Buffer.from(term.term, "utf8");
          let offset = contentBytes.indexOf(needle);
          while (offset >= 0) {
            const covered = symbols.some((s) => offset >= s.startByte && offset < s.endByte);
            if (!covered) { outside = true; break; }
            offset = contentBytes.indexOf(needle, offset + 1);
          }
        }
        hits.push({
          term: term.term,
          shape: term.shape,
          in_derived_task: term.in_derived_task,
          repo_content_match_count: inContent ? scanned(term).content_match_count : 0,
          matched_in_path: inPath,
          outside_symbol_ranges: outside,
        });
      }
      hidden.push({
        hidden_path: hiddenPath,
        pool_fate: poolFate,
        file_kind: classifyFile(hiddenPath),
        size_bytes: contentBytes?.length ?? 0,
        indexed_symbol_count: symbols.length,
        extended_pool_rank: extendedRankByFile.get(hiddenPath) ?? null,
        extended_pool_file_rank: hiddenFileRank,
        hits,
        derived_task_hit_count: hits.filter((h) => h.in_derived_task).length,
        full_only_hit_count: hits.filter((h) => !h.in_derived_task).length,
      });
    }

    // Noise simulation over EVERY scored case, derived-task terms only (that is
    // all the product lane could ever see). A term with 1..5 exact content
    // matches nominates the matched files not already in the pool.
    const simulated: SimulatedFileCandidate[] = [];
    const isGold = (p: string): boolean => row.gold.scored_files.some((g) => fileMatches(g, p));
    const simSeen = new Set<string>();
    for (const term of derivedTerms) {
      const s = scanned(term);
      if (s.content_match_count === 0 || s.content_match_count > 5) continue;
      for (const p of s.content_matches_sample) {
        if (poolPaths.has(p)) continue;
        const key = `${term.term}|${p}`;
        if (simSeen.has(key)) continue;
        simSeen.add(key);
        simulated.push({
          path: p,
          term: term.term,
          shape: term.shape,
          ambiguity: s.content_match_count,
          file_kind: classifyFile(p),
          term_length: term.term.length,
          is_gold: isGold(p),
        });
      }
    }
    // Organic-rescue simulation: every source-like file the extended organic
    // probe reached that is MISSING from the actual pool, with its probe rank
    // and the best derived-task evidence its raw text carries.
    const organicRescue: OrganicRescueCandidate[] = [];
    for (const [p, rank] of extendedRankByFile) {
      if (poolPaths.has(p)) continue;
      const content = repo.byPath.get(p) ?? null;
      let minAmb: number | null = null;
      const shapes = new Set<EvidenceShape>();
      if (content !== null) {
        for (const term of derivedTerms) {
          if (!content.includes(term.term)) continue;
          const s = scanned(term);
          if (s.content_match_count === 0) continue;
          if (minAmb === null || s.content_match_count < minAmb) minAmb = s.content_match_count;
          shapes.add(term.shape);
        }
      }
      organicRescue.push({
        path: p,
        rank,
        file_rank: extendedFileRank.get(p)!,
        file_kind: classifyFile(p),
        is_gold: isGold(p),
        derived_evidence_min_ambiguity: minAmb,
        derived_evidence_shapes: [...shapes].sort(),
      });
    }
    organicRescue.sort((a, b) => a.rank - b.rank);
    db.close();

    cases.push({
      instance_id: row.instance_id,
      repo: row.repo,
      cohort,
      outcome: row.outcome ?? "unknown",
      multi_file: row.gold.multi_file,
      hidden_gold_count: hiddenGold.length,
      hidden: cohort === "dev"
        ? hidden
        : hidden.map((h) => ({
            ...h,
            hidden_path: "(holdout: redacted)",
            hits: h.hits.map((x) => ({ ...x, term: "(holdout: redacted)" })),
          })),
      derived_task_term_count: derivedTerms.length,
      simulated_candidates: cohort === "dev"
        ? simulated
        : simulated.map((s) => ({ ...s, path: "(holdout: redacted)", term: "(holdout: redacted)" })),
      organic_rescue_candidates: cohort === "dev"
        ? organicRescue
        : organicRescue.map((s) => ({ ...s, path: "(holdout: redacted)" })),
    });
    process.stdout.write(
      `✓ ${row.instance_id} (${cohort}): hidden=${hiddenGold.length}`
      + ` fates=[${hidden.map((h) => h.pool_fate.split(":")[0]).join(",")}]`
      + ` extRank=[${hidden.map((h) => h.extended_pool_rank ?? "-").join(",")}]`
      + ` devHits=[${hidden.map((h) => h.derived_task_hit_count).join(",")}]`
      + ` sim=${simulated.length} (${simulated.filter((s) => s.is_gold).length} gold)\n`,
    );
  }

  // ---- aggregates -------------------------------------------------------------
  const fateCounts: Record<string, Record<string, number>> = { dev: {}, holdout: {} };
  const kindCounts: Record<string, Record<string, number>> = { dev: {}, holdout: {} };
  const reachCounts: Record<string, Record<string, number>> = { dev: {}, holdout: {} };
  for (const c of cases) {
    for (const h of c.hidden) {
      const fate = h.pool_fate.startsWith("discarded") ? "in_pool_not_capsule" : h.pool_fate;
      fateCounts[c.cohort]![fate] = (fateCounts[c.cohort]![fate] ?? 0) + 1;
      kindCounts[c.cohort]![h.file_kind] = (kindCounts[c.cohort]![h.file_kind] ?? 0) + 1;
      if (fate !== "absent_from_pool" && fate !== "not_in_index") continue;
      // Reachability of ABSENT files, best route first.
      const derivedExact = h.hits.filter((x) => x.in_derived_task);
      const route = h.extended_pool_rank !== null
        ? "organic_deeper_pool"
        : derivedExact.some((x) => x.repo_content_match_count >= 1 && x.repo_content_match_count <= 5)
          ? "file_evidence_low_ambiguity"
          : derivedExact.length > 0
            ? "file_evidence_ambiguous_or_path"
            : h.hits.length > 0
              ? "evidence_only_in_full_statement"
              : "no_lexical_evidence";
      reachCounts[c.cohort]![route] = (reachCounts[c.cohort]![route] ?? 0) + 1;
    }
  }

  // Gate sweep over the simulated file-evidence candidates.
  interface GateResult {
    gate: string;
    dev: { candidates: number; gold: number; cases_with_any: number };
    holdout: { candidates: number; gold: number; cases_with_any: number };
  }
  const STRONG_SHAPES = new Set<EvidenceShape>([
    "backticked_span", "quoted_string", "error_fragment", "code_token", "dunder_identifier",
  ]);
  const gates: Array<{ name: string; test: (s: SimulatedFileCandidate) => boolean }> = [
    { name: "any_shape_amb<=5", test: () => true },
    { name: "any_shape_amb<=3", test: (s) => s.ambiguity <= 3 },
    { name: "any_shape_amb=1", test: (s) => s.ambiguity === 1 },
    { name: "source_only_amb<=5", test: (s) => s.file_kind === "source" },
    { name: "source_only_amb<=3", test: (s) => s.file_kind === "source" && s.ambiguity <= 3 },
    { name: "strong_shapes_amb<=5", test: (s) => STRONG_SHAPES.has(s.shape) },
    { name: "strong_shapes_amb<=3", test: (s) => STRONG_SHAPES.has(s.shape) && s.ambiguity <= 3 },
    { name: "strong_shapes_src_amb<=5", test: (s) => STRONG_SHAPES.has(s.shape) && s.file_kind === "source" },
    { name: "strong_shapes_src_amb<=3", test: (s) => STRONG_SHAPES.has(s.shape) && s.file_kind === "source" && s.ambiguity <= 3 },
    { name: "strong_shapes_src_len>=12_amb<=3", test: (s) => STRONG_SHAPES.has(s.shape) && s.file_kind === "source" && s.term_length >= 12 && s.ambiguity <= 3 },
    { name: "snake_src_amb<=3", test: (s) => s.shape === "snake_identifier" && s.file_kind === "source" && s.ambiguity <= 3 },
    { name: "camel_src_amb<=3", test: (s) => s.shape === "camel_identifier" && s.file_kind === "source" && s.ambiguity <= 3 },
    { name: "dotted_src_amb<=3", test: (s) => s.shape === "dotted_path" && s.file_kind === "source" && s.ambiguity <= 3 },
    { name: "exception_src_amb<=3", test: (s) => s.shape === "exception_name" && s.file_kind === "source" && s.ambiguity <= 3 },
  ];
  const gateSweep: GateResult[] = gates.map((g) => {
    const result: GateResult = {
      gate: g.name,
      dev: { candidates: 0, gold: 0, cases_with_any: 0 },
      holdout: { candidates: 0, gold: 0, cases_with_any: 0 },
    };
    for (const c of cases) {
      // Dedupe by path within a case (several terms may nominate one file).
      const passing = new Map<string, SimulatedFileCandidate>();
      for (const s of c.simulated_candidates) {
        if (g.test(s) && !passing.has(s.path)) passing.set(s.path, s);
      }
      const bucket = result[c.cohort];
      bucket.candidates += passing.size;
      bucket.gold += [...passing.values()].filter((s) => s.is_gold).length;
      if (passing.size > 0) bucket.cases_with_any += 1;
    }
    return result;
  });

  // Gate sweep over the organic-rescue candidates (seam C: files the organic
  // generators reached but the actual pool lost). Every gate is gold-blind.
  const rescueGates: Array<{ name: string; test: (s: OrganicRescueCandidate) => boolean }> = [
    { name: "rank<=25 (evicted by injections)", test: (s) => s.rank <= 25 },
    { name: "rank<=25 source", test: (s) => s.rank <= 25 && s.file_kind === "source" },
    { name: "rank<=25 source ev<=5", test: (s) => s.rank <= 25 && s.file_kind === "source" && s.derived_evidence_min_ambiguity !== null && s.derived_evidence_min_ambiguity <= 5 },
    { name: "rank<=50 source", test: (s) => s.rank <= 50 && s.file_kind === "source" },
    { name: "rank<=50 source ev<=5", test: (s) => s.rank <= 50 && s.file_kind === "source" && s.derived_evidence_min_ambiguity !== null && s.derived_evidence_min_ambiguity <= 5 },
    { name: "rank<=100 source ev<=5", test: (s) => s.rank <= 100 && s.file_kind === "source" && s.derived_evidence_min_ambiguity !== null && s.derived_evidence_min_ambiguity <= 5 },
    { name: "rank<=100 source ev<=3", test: (s) => s.rank <= 100 && s.file_kind === "source" && s.derived_evidence_min_ambiguity !== null && s.derived_evidence_min_ambiguity <= 3 },
    { name: "rank<=400 source ev<=3", test: (s) => s.file_kind === "source" && s.derived_evidence_min_ambiguity !== null && s.derived_evidence_min_ambiguity <= 3 },
    { name: "rank<=400 source ev=1", test: (s) => s.file_kind === "source" && s.derived_evidence_min_ambiguity === 1 },
    // File-diversity framing: the pool counts SYMBOLS (25 symbols ≈ 9 files),
    // so gate on rank among DISTINCT FILES of the organic ordering instead.
    { name: "filerank<=10 source", test: (s) => s.file_rank <= 10 && s.file_kind === "source" },
    { name: "filerank<=12 source", test: (s) => s.file_rank <= 12 && s.file_kind === "source" },
    { name: "filerank<=15 source", test: (s) => s.file_rank <= 15 && s.file_kind === "source" },
    { name: "filerank<=20 source", test: (s) => s.file_rank <= 20 && s.file_kind === "source" },
    { name: "filerank<=12 source ev<=5", test: (s) => s.file_rank <= 12 && s.file_kind === "source" && s.derived_evidence_min_ambiguity !== null && s.derived_evidence_min_ambiguity <= 5 },
    { name: "filerank<=15 source ev<=5", test: (s) => s.file_rank <= 15 && s.file_kind === "source" && s.derived_evidence_min_ambiguity !== null && s.derived_evidence_min_ambiguity <= 5 },
    { name: "filerank<=20 source ev<=5", test: (s) => s.file_rank <= 20 && s.file_kind === "source" && s.derived_evidence_min_ambiguity !== null && s.derived_evidence_min_ambiguity <= 5 },
    { name: "filerank<=30 source ev<=5", test: (s) => s.file_rank <= 30 && s.file_kind === "source" && s.derived_evidence_min_ambiguity !== null && s.derived_evidence_min_ambiguity <= 5 },
  ];
  const rescueSweep = rescueGates.map((g) => {
    const result = {
      gate: g.name,
      dev: { candidates: 0, gold: 0, cases_with_any: 0, max_per_case: 0 },
      holdout: { candidates: 0, gold: 0, cases_with_any: 0, max_per_case: 0 },
    };
    for (const c of cases) {
      const passing = c.organic_rescue_candidates.filter(g.test);
      const bucket = result[c.cohort];
      bucket.candidates += passing.length;
      bucket.gold += passing.filter((s) => s.is_gold).length;
      if (passing.length > 0) bucket.cases_with_any += 1;
      bucket.max_per_case = Math.max(bucket.max_per_case, passing.length);
    }
    return result;
  });

  await mkdir(RESULTS_ROOT, { recursive: true });
  await writeFile(
    path.join(RESULTS_ROOT, "stage5_m100_candidate_pool_recall_gap_audit.json"),
    JSON.stringify({
      milestone: "M100",
      kind: "Candidate-pool recall gap audit over frozen M99 cases (file-level evidence scan)",
      live_agents: false, docker: false, api_spend: false,
      cases_total: cases.length,
      cases_with_hidden_gold: cases.filter((c) => c.hidden_gold_count > 0).length,
      hidden_pool_fate_counts: fateCounts,
      hidden_file_kind_counts: kindCounts,
      absent_reachability_counts: reachCounts,
      gate_sweep: gateSweep,
      organic_rescue_sweep: rescueSweep,
      cases: cases.filter(
        (c) => c.hidden_gold_count > 0
          || c.simulated_candidates.length > 0
          || c.organic_rescue_candidates.length > 0,
      ),
    }, null, 2) + "\n",
    "utf8",
  );
  process.stdout.write(`\nwrote ${path.join(RESULTS_ROOT, "stage5_m100_candidate_pool_recall_gap_audit.json")}\n`);
  process.stdout.write(`pool fate dev: ${JSON.stringify(fateCounts["dev"])}\n`);
  process.stdout.write(`pool fate holdout: ${JSON.stringify(fateCounts["holdout"])}\n`);
  process.stdout.write(`absent reachability dev: ${JSON.stringify(reachCounts["dev"])}\n`);
  process.stdout.write(`absent reachability holdout: ${JSON.stringify(reachCounts["holdout"])}\n`);
  for (const g of gateSweep) {
    process.stdout.write(
      `gate ${g.gate}: dev ${g.dev.gold}/${g.dev.candidates} gold (cases ${g.dev.cases_with_any});`
      + ` holdout ${g.holdout.gold}/${g.holdout.candidates} gold (cases ${g.holdout.cases_with_any})\n`,
    );
  }
  for (const g of rescueSweep) {
    process.stdout.write(
      `rescue ${g.gate}: dev ${g.dev.gold}/${g.dev.candidates} gold (cases ${g.dev.cases_with_any}, max/case ${g.dev.max_per_case});`
      + ` holdout ${g.holdout.gold}/${g.holdout.candidates} gold (cases ${g.holdout.cases_with_any}, max/case ${g.holdout.max_per_case})\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
