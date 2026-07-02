// Stage 5 M96 — candidate-pool gap audit (pre-change, deterministic, offline).
//
// For every M95 miss/wrong_pivot case, re-run buildCapsuleV2 over the clean
// base-commit index and classify each scored gold file as:
//   - in_capsule          (emitted as pivot/support — a ranking/lead problem)
//   - in_pool_not_capsule (retrieved but discarded — a ranking/budget problem)
//   - absent_from_pool    (never retrieved — the real candidate-recall gap)
//
// For ABSENT-gold cases it then audits the issue-derived task text for
// high-confidence code mentions (dotted module paths, file basenames, quoted or
// backticked identifiers, bare symbol names, exception names) and resolves each
// against the SAME index, recording how many repo files/symbols the mention
// matches exactly and whether any match is gold. This answers, per mention type,
// "could a narrow direct-evidence lane have recovered the absent gold, and at
// what ambiguity?" — without changing any product logic.
//
// Split discipline: dev cases get full per-case detail; holdout cases contribute
// ONLY to aggregate counters (no per-case mention detail is emitted), so
// implementation decisions cannot overfit the holdout.
//
// Gold is used ONLY to label the audit output. It is never passed into capsule
// generation. NO Claude, NO Docker, NO API calls, NO live network.

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent, type CapsuleV2Result } from "../../src/capsuleV2/types";

import {
  deriveTaskFromProblemStatement,
  loadSweBench,
} from "./build_stage5_retrieval_fixture";
import { fileMatches } from "./run_stage5_retrieval_eval";
import { assertNoGoldLeakage, extractGold } from "./stage5_m94_lib";

const DEFAULT_DATA = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
const RESULTS_ROOT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");
const WS_ROOT = path.join(RESULTS_ROOT, "workspaces");
const INDEX_RELPATH = path.join(".vtrace", "index.sqlite");
const CLEAN_WS_ROOTS = ["expanded", "cross_repo"] as const;
const CAPSULE_BUDGET = 8000;

function resolveCleanWorkspace(instanceId: string): string | null {
  for (const root of CLEAN_WS_ROOTS) {
    const ws = path.join(WS_ROOT, root, instanceId);
    if (existsSync(path.join(ws, INDEX_RELPATH))) return ws;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mention extraction (audit-time mirror of a possible direct-evidence lane)
// ---------------------------------------------------------------------------

type MentionType =
  | "dotted_module_path"
  | "file_path_or_basename"
  | "quoted_or_backticked"
  | "symbol_name"
  | "exception_name"
  | "config_or_constant"
  | "bare_stem_word"
  | "capitalized_class_word"
  | "kebab_option";

interface Mention {
  readonly text: string;
  readonly type: MentionType;
}

function extractMentions(task: string): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  const push = (text: string, type: MentionType): void => {
    const t = text.trim();
    const key = `${type}|${t}`;
    if (t.length < 3 || seen.has(key)) return;
    seen.add(key);
    out.push({ text: t, type });
  };

  for (const m of task.matchAll(/[`'"]([^`'"\n]+)[`'"]/g)) {
    const inner = (m[1] ?? "").trim();
    if (/^[\w./-]+$/.test(inner)) push(inner, "quoted_or_backticked");
  }
  for (const m of task.matchAll(/\b[\w./-]+\.py\b/g)) push(m[0], "file_path_or_basename");
  for (const m of task.matchAll(/\b[a-z_][\w]*(?:\.[a-z_][\w]*){1,}\b/gi)) {
    if (!m[0].endsWith(".py")) push(m[0], "dotted_module_path");
  }
  for (const m of task.matchAll(/\b[A-Z]\w*(?:Error|Exception|Warning)\b/g)) push(m[0], "exception_name");
  for (const m of task.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) push(m[0], "config_or_constant");
  for (const m of task.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) push(m[0], "symbol_name");
  for (const m of task.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) {
    if (!/(?:Error|Exception|Warning)$/.test(m[0])) push(m[0], "symbol_name");
  }
  // Weaker shapes, probed to size the recoverable signal (the audit decides
  // whether any is safe enough for a product lane):
  // single lowercase words (possible file stems), single Capitalized words
  // (possible class names), kebab-case option names (possible config keys).
  for (const m of task.matchAll(/\b[a-z][a-z0-9]{3,}\b/g)) push(m[0], "bare_stem_word");
  for (const m of task.matchAll(/\b[A-Z][a-z0-9]{2,}\b/g)) {
    if (!/(?:Error|Exception|Warning)$/.test(m[0])) push(m[0], "capitalized_class_word");
  }
  for (const m of task.matchAll(/\b[a-z][a-z0-9]+(?:-[a-z0-9]+)+\b/g)) push(m[0], "kebab_option");
  return out;
}

// ---------------------------------------------------------------------------
// Index resolution probes
// ---------------------------------------------------------------------------

interface ResolutionProbe {
  readonly mention: string;
  readonly type: MentionType;
  /** How many indexed files this mention matches exactly (path/basename/module form). */
  readonly file_matches: number;
  /** How many indexed non-test symbols carry this exact local name. */
  readonly symbol_matches: number;
  /** True when at least one exact file match IS a gold file. */
  readonly file_match_hits_gold: boolean;
  /** True when at least one exact-name symbol lives in a gold file. */
  readonly symbol_match_hits_gold: boolean;
  /** Sample matched paths (bounded, for the audit narrative). */
  readonly sample_paths: string[];
}

interface DbHandle {
  filePaths: string[];
  /** local_name -> file paths of NON-TEST symbols with that exact name. */
  symbolFilesByName: Map<string, string[]>;
}

function loadDbHandle(dbPath: string): DbHandle {
  const db = openIndexerDatabase(dbPath);
  try {
    const filePaths = (db.query("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>)
      .map((r) => r.path);
    const rows = db
      .query(
        `SELECT s.local_name AS name, f.path AS path
         FROM symbols s JOIN files f ON f.id = s.file_id`,
      )
      .all() as Array<{ name: string; path: string }>;
    const symbolFilesByName = new Map<string, string[]>();
    for (const row of rows) {
      if (/(^|\/)tests?\//.test(row.path) || /(^|\/)test_[^/]+$/.test(row.path)) continue;
      const list = symbolFilesByName.get(row.name);
      if (list === undefined) symbolFilesByName.set(row.name, [row.path]);
      else list.push(row.path);
    }
    return { filePaths, symbolFilesByName };
  } finally {
    db.close();
  }
}

// Files an exact mention resolves to: full/suffix path match for path-shaped
// mentions, exact basename match for bare basenames, and module-path suffix
// match for dotted mentions (a.b.c -> .../a/b/c.py or .../a/b.py).
function resolveMentionToFiles(mention: Mention, filePaths: readonly string[]): string[] {
  const text = mention.text.replace(/^[ab]\//, "");
  const matches = new Set<string>();

  if (text.endsWith(".py")) {
    if (text.includes("/")) {
      for (const p of filePaths) {
        if (p === text || p.endsWith(`/${text}`) || text.endsWith(`/${p}`)) matches.add(p);
      }
    } else {
      for (const p of filePaths) {
        if (p === text || p.endsWith(`/${text}`)) matches.add(p);
      }
    }
    return [...matches];
  }

  if (mention.type === "bare_stem_word") {
    // A bare lowercase word resolves ONLY as an exact file stem (basename minus
    // extension) — the shape a prose sentence uses to name a module ("autoreload").
    for (const p of filePaths) {
      const base = p.slice(p.lastIndexOf("/") + 1);
      if (base === `${text}.py`) matches.add(p);
    }
    return [...matches];
  }

  if (mention.type === "kebab_option") {
    // A kebab option ("bad-names-rgxs") resolves as its snake_case twin's file
    // stem; symbol resolution is handled by the symbol probe on the snake form.
    const snake = text.replace(/-/g, "_");
    for (const p of filePaths) {
      const base = p.slice(p.lastIndexOf("/") + 1);
      if (base === `${snake}.py`) matches.add(p);
    }
    return [...matches];
  }

  if (mention.type === "dotted_module_path" || (mention.type === "quoted_or_backticked" && text.includes("."))) {
    const segments = text.split(".").filter((s) => /^[A-Za-z_]\w*$/.test(s));
    if (segments.length >= 2) {
      // Longest resolvable module prefix: try a/b/c.py, then a/b.py, then a.py —
      // trailing segments are symbols, not path parts.
      for (let take = segments.length; take >= 1; take -= 1) {
        const rel = `${segments.slice(0, take).join("/")}.py`;
        const pkg = `${segments.slice(0, take).join("/")}/__init__.py`;
        for (const p of filePaths) {
          if (p === rel || p.endsWith(`/${rel}`)) matches.add(p);
          if (p === pkg || p.endsWith(`/${pkg}`)) matches.add(p);
        }
        if (matches.size > 0) break;
      }
    }
    return [...matches];
  }

  return [];
}

function probeMention(mention: Mention, handle: DbHandle, goldFiles: readonly string[]): ResolutionProbe {
  const fileHits = resolveMentionToFiles(mention, handle.filePaths);
  const last = mention.text.includes(".") ? mention.text.slice(mention.text.lastIndexOf(".") + 1) : mention.text;
  const snake = mention.type === "kebab_option" ? mention.text.replace(/-/g, "_") : undefined;
  const symbolHits = [
    ...(handle.symbolFilesByName.get(mention.text) ?? []),
    ...(mention.text !== last ? handle.symbolFilesByName.get(last) ?? [] : []),
    ...(snake !== undefined ? handle.symbolFilesByName.get(snake) ?? [] : []),
  ];
  const goldHit = (p: string): boolean => goldFiles.some((g) => fileMatches(g, p));
  return {
    mention: mention.text,
    type: mention.type,
    file_matches: fileHits.length,
    symbol_matches: symbolHits.length,
    file_match_hits_gold: fileHits.some(goldHit),
    symbol_match_hits_gold: symbolHits.some(goldHit),
    sample_paths: [...new Set([...fileHits, ...symbolHits])].slice(0, 4),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type GoldPoolStatus = "in_capsule" | "in_pool_not_capsule" | "absent_from_pool";

interface GoldFileStatus {
  readonly gold_file: string;
  readonly status: GoldPoolStatus;
  /** Final score of the best pool entry for this gold file, when present. */
  readonly best_final_score: number | null;
  readonly discard_reason: string | null;
}

interface MissRef {
  instance_id: string;
  in_dev: boolean;
}

async function main(): Promise<void> {
  const dataPath = process.argv.includes("--swe-bench-data")
    ? process.argv[process.argv.indexOf("--swe-bench-data") + 1]!
    : DEFAULT_DATA;

  const failureModes = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m95_deterministic_failure_modes.json"), "utf8"),
  ) as { misses: MissRef[] };
  const swe = await loadSweBench(dataPath);

  const devRows: unknown[] = [];
  // Case ids whose gold is (partly) absent from the pool, per cohort — the
  // absent-gold subset the M96 scoreboard compares on. Ids only (they are
  // already public in stage5_m95_deterministic_top_misses.csv); no holdout
  // per-case detail is emitted.
  const absentCaseIds: { dev: string[]; holdout: string[] } = { dev: [], holdout: [] };
  const holdoutAgg = {
    cases: 0,
    gold_files: 0,
    absent_from_pool: 0,
    in_pool_not_capsule: 0,
    in_capsule: 0,
    absent_cases: 0,
    absent_cases_with_exact_resolvable_mention: 0,
  };
  const devAgg = { ...holdoutAgg };

  for (const miss of failureModes.misses) {
    const instance = swe.get(miss.instance_id);
    if (instance === undefined) continue;
    const workspace = resolveCleanWorkspace(miss.instance_id);
    if (workspace === null) continue;

    const gold = extractGold(instance.patch);
    const task = deriveTaskFromProblemStatement(instance.problem_statement);
    if (task.length === 0 || assertNoGoldLeakage(task, gold) !== null) continue;

    const dbPath = path.join(workspace, INDEX_RELPATH);
    const db = openIndexerDatabase(dbPath);
    let result: CapsuleV2Result;
    try {
      result = buildCapsuleV2({
        db,
        repoRoot: workspace,
        task,
        intent: CapsuleIntent.Debug,
        maxTokens: CAPSULE_BUDGET,
      });
    } finally {
      db.close();
    }

    const capsulePaths = [...result.pivots, ...result.support].map((it) => it.path);
    const pooled = new Map<string, { final: number; discard: string | null }>();
    for (const it of [...result.pivots, ...result.support]) {
      const prev = pooled.get(it.path);
      if (prev === undefined || it.scorecard.final > prev.final) {
        pooled.set(it.path, { final: it.scorecard.final, discard: null });
      }
    }
    for (const d of result.discarded) {
      const prev = pooled.get(d.path);
      if (prev === undefined) pooled.set(d.path, { final: d.scorecard.final, discard: d.discard_reason });
      else if (d.scorecard.final > prev.final) pooled.set(d.path, { final: d.scorecard.final, discard: prev.discard });
    }

    const goldStatuses: GoldFileStatus[] = gold.scoredFiles.map((g) => {
      const inCapsule = capsulePaths.some((p) => fileMatches(g, p));
      const poolEntry = [...pooled.entries()].find(([p]) => fileMatches(g, p));
      const status: GoldPoolStatus = inCapsule
        ? "in_capsule"
        : poolEntry !== undefined
          ? "in_pool_not_capsule"
          : "absent_from_pool";
      return {
        gold_file: g,
        status,
        best_final_score: poolEntry?.[1].final ?? null,
        discard_reason: poolEntry?.[1].discard ?? null,
      };
    });

    const anyAbsent = goldStatuses.some((s) => s.status === "absent_from_pool");
    const handle = loadDbHandle(dbPath);
    const mentions = extractMentions(task);
    const probes = mentions.map((m) => probeMention(m, handle, gold.scoredFiles));
    const exactResolvable = probes.some(
      (p) =>
        (p.file_match_hits_gold && p.file_matches <= 3)
        || (p.symbol_match_hits_gold && p.symbol_matches <= 5),
    );

    const agg = miss.in_dev ? devAgg : holdoutAgg;
    agg.cases += 1;
    agg.gold_files += goldStatuses.length;
    for (const s of goldStatuses) {
      if (s.status === "absent_from_pool") agg.absent_from_pool += 1;
      else if (s.status === "in_pool_not_capsule") agg.in_pool_not_capsule += 1;
      else agg.in_capsule += 1;
    }
    if (anyAbsent) {
      agg.absent_cases += 1;
      absentCaseIds[miss.in_dev ? "dev" : "holdout"].push(miss.instance_id);
      if (exactResolvable) agg.absent_cases_with_exact_resolvable_mention += 1;
    }

    if (miss.in_dev) {
      devRows.push({
        instance_id: miss.instance_id,
        repo: instance.repo,
        task,
        gold_statuses: goldStatuses,
        capsule_files: capsulePaths,
        mention_probes: probes.filter(
          (p) => p.file_matches > 0 || p.symbol_matches > 0 || p.type !== "symbol_name",
        ),
        any_gold_absent: anyAbsent,
        exact_resolvable_mention_hits_gold: exactResolvable,
      });
      process.stdout.write(
        `✓ ${miss.instance_id}: ${goldStatuses.map((s) => `${path.basename(s.gold_file)}=${s.status}`).join(" ")}`
        + `${anyAbsent ? ` resolvable=${exactResolvable}` : ""}\n`,
      );
    } else {
      process.stdout.write(`· ${miss.instance_id}: holdout (aggregate only)\n`);
    }
  }

  const out = {
    milestone: "M96",
    kind: "Candidate-pool gap audit over M95 misses (pre-change)",
    live_agents: false,
    docker: false,
    api_spend: false,
    dev_aggregate: devAgg,
    holdout_aggregate: holdoutAgg,
    absent_case_ids: absentCaseIds,
    dev_cases: devRows,
  };
  const outPath = path.join(RESULTS_ROOT, "stage5_m96_candidate_pool_gap_audit.json");
  await writeFile(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");
  process.stdout.write(`\nwrote ${outPath}\n`);
  process.stdout.write(
    `dev: ${JSON.stringify(devAgg)}\nholdout: ${JSON.stringify(holdoutAgg)}\n`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
