// Stage 5 M102 — task-derivation evidence-loss audit (read-only, text-level).
//
// The M100/M101 standing finding says the 360-char derived task is now the
// binding deterministic constraint: gold-relevant evidence often lives only in
// the FULL problem statement (code blocks, tracebacks, later paragraphs). This
// script quantifies that loss WITHOUT building any capsule: for every scored
// instance it derives the gold evidence vocabulary (file names, path suffixes,
// dotted modules, symbols — audit-side only, never fed anywhere), then locates
// each term in the derived task and in the full problem statement, bucketing by
// character position (≤360 / ≤720 / ≤1200 / beyond) and by textual context
// (prose / code block / traceback). Per-case rows are emitted for DEV cases
// only; holdout contributes to aggregates alone (split discipline).
//
// NO Claude, NO Docker, NO agent run, NO API calls, NO live network.

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  deriveTaskFromProblemStatement,
  loadSweBench,
  type SweBenchInstance,
} from "./build_stage5_retrieval_fixture";
import { extractGold } from "./stage5_m94_lib";

const DEFAULT_DATA = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
const RESULTS_ROOT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");

// --- gold evidence vocabulary (audit-side ONLY) --------------------------------

type TermKind =
  | "file_basename"
  | "file_stem"
  | "path_suffix"
  | "dotted_module"
  | "symbol"
  | "class_method";

interface EvidenceTerm {
  readonly term: string;
  readonly kind: TermKind;
  /** Case-insensitive match for file-ish terms, sensitive for symbols. */
  readonly caseSensitive: boolean;
}

// The vocabulary a retrieval lane could plausibly anchor on for one gold file.
function goldEvidenceTerms(sourceFiles: readonly string[], symbols: readonly string[]): EvidenceTerm[] {
  const out: EvidenceTerm[] = [];
  const seen = new Set<string>();
  const push = (term: string, kind: TermKind, caseSensitive: boolean) => {
    const key = `${kind}|${term}`;
    if (term.length < 3 || seen.has(key)) return;
    seen.add(key);
    out.push({ term, kind, caseSensitive });
  };
  for (const file of sourceFiles) {
    const parts = file.split("/");
    const basename = parts.at(-1) ?? file;
    push(basename, "file_basename", false);
    const stem = basename.replace(/\.[a-z]+$/i, "");
    // `__init__` / `utils`-class stems are too generic to count as evidence.
    if (!/^(__init__|utils?|base|core|main|common)$/i.test(stem)) {
      push(stem, "file_stem", false);
    }
    if (parts.length >= 2) push(parts.slice(-2).join("/"), "path_suffix", false);
    const moduleParts = file.replace(/\.py$/, "").split("/").filter((p) => p !== "__init__");
    if (moduleParts.length >= 2) push(moduleParts.slice(-2).join("."), "dotted_module", false);
  }
  for (const symbol of symbols) {
    if (symbol.includes(".")) {
      push(symbol, "class_method", true);
      const method = symbol.split(".").pop()!;
      if (!/^(__init__|__str__|__repr__|get|set|run|main)$/.test(method)) push(method, "symbol", true);
    } else if (!/^(test_|__)/.test(symbol)) {
      push(symbol, "symbol", true);
    }
  }
  return out;
}

// --- text scanning --------------------------------------------------------------

function cleanStatement(problemStatement: string): string {
  return problemStatement.replace(/[​‌‍﻿]/g, "").replace(/\r/g, "");
}

// Boundary-aware first index of `term` in `text` (identifier chars must not
// continue on either side, so `evalf` does not match `evalf_table` — but a
// path/backtick context still matches).
function firstIndexOf(text: string, term: string, caseSensitive: boolean): number {
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? term : term.toLowerCase();
  let from = 0;
  while (from < hay.length) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) return -1;
    const before = idx > 0 ? hay[idx - 1]! : " ";
    const after = idx + needle.length < hay.length ? hay[idx + needle.length]! : " ";
    const boundary = (ch: string) => !/[A-Za-z0-9_]/.test(ch);
    // A path-ish term may be preceded by '/' legitimately; identifiers may not.
    const beforeOk = boundary(before) || before === "/" || before === ".";
    if (beforeOk && boundary(after)) return idx;
    from = idx + 1;
  }
  return -1;
}

type ContextKind = "prose" | "code_block" | "traceback";

// Classify the character offset's context: inside a ``` fence, on/near a
// traceback line, or plain prose.
function contextAt(text: string, offset: number): ContextKind {
  const lines = text.split("\n");
  let pos = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const end = pos + line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (offset < end) {
      if (/^\s*(Traceback \(most recent call last\)|File ")/.test(line) || /^\s+File "/.test(line)) {
        return "traceback";
      }
      // A traceback body line: look one line up for a `File "` header.
      if (i > 0 && /^\s*File "/.test(lines[i - 1]!)) return "traceback";
      return inFence ? "code_block" : "prose";
    }
    pos = end;
  }
  return "prose";
}

// Rough identifier-noise measure for a text window: distinct code-like tokens
// (snake_case, CamelCase, dotted, UPPER_SNAKE) — the tokens a longer task would
// add to lexical scoring whether or not they are gold-relevant.
export function codeLikeTokenCount(text: string): number {
  const tokens = new Set<string>();
  for (const m of text.matchAll(/\b(?:[a-z0-9]+_[a-z0-9_]+|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[A-Z_]{3,}|[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*){2,})\b/g)) {
    tokens.add(m[0]!);
  }
  return tokens.size;
}

// --- per-case audit ---------------------------------------------------------------

interface TermFinding {
  readonly term: string;
  readonly kind: TermKind;
  readonly in_v0_task: boolean;
  /** First char offset in the cleaned FULL problem statement, or null. */
  readonly statement_offset: number | null;
  readonly bucket: "in_v0" | "le_360" | "le_720" | "le_1200" | "beyond_1200" | "absent";
  readonly context: ContextKind | null;
}

interface CaseRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly cohort: "dev" | "holdout";
  readonly m101_outcome: string | null;
  readonly m101_failure_reasons: string[];
  readonly statement_chars: number;
  readonly v0_task_chars: number;
  readonly term_count: number;
  readonly terms_in_v0: number;
  readonly terms_beyond_v0: number;
  readonly has_evidence_beyond_v0: boolean;
  /** Earliest recoverable evidence beyond V0: which prefix window reaches it. */
  readonly earliest_beyond_bucket: "le_360" | "le_720" | "le_1200" | "beyond_1200" | null;
  readonly beyond_contexts: Record<string, number>;
  readonly beyond_kinds: Record<string, number>;
  readonly code_like_tokens_360: number;
  readonly code_like_tokens_720: number;
  readonly code_like_tokens_1200: number;
  readonly code_like_tokens_full: number;
  /** Dev-only: the individual term findings (split discipline). */
  readonly findings: TermFinding[] | null;
}

function auditInstance(
  inst: SweBenchInstance,
  cohort: "dev" | "holdout",
  m101Outcome: string | null,
  m101Reasons: string[],
): CaseRow | null {
  const gold = extractGold(inst.patch);
  if (gold.sourceFiles.length === 0) return null;
  const statement = cleanStatement(inst.problem_statement);
  const v0 = deriveTaskFromProblemStatement(inst.problem_statement);
  const terms = goldEvidenceTerms(gold.sourceFiles, gold.symbols);

  const findings: TermFinding[] = terms.map((t) => {
    const inV0 = firstIndexOf(v0, t.term, t.caseSensitive) !== -1;
    const offset = firstIndexOf(statement, t.term, t.caseSensitive);
    const bucket = inV0
      ? "in_v0" as const
      : offset === -1
        ? "absent" as const
        : offset < 360
          ? "le_360" as const
          : offset < 720
            ? "le_720" as const
            : offset < 1200
              ? "le_1200" as const
              : "beyond_1200" as const;
    return {
      term: t.term,
      kind: t.kind,
      in_v0_task: inV0,
      statement_offset: offset === -1 ? null : offset,
      bucket,
      context: offset === -1 ? null : contextAt(statement, offset),
    };
  });

  const beyond = findings.filter((f) => !f.in_v0_task && f.statement_offset !== null);
  const beyondContexts: Record<string, number> = {};
  const beyondKinds: Record<string, number> = {};
  for (const f of beyond) {
    beyondContexts[f.context!] = (beyondContexts[f.context!] ?? 0) + 1;
    beyondKinds[f.kind] = (beyondKinds[f.kind] ?? 0) + 1;
  }
  const bucketRank = { le_360: 0, le_720: 1, le_1200: 2, beyond_1200: 3 } as const;
  const earliest = beyond.length > 0
    ? beyond.reduce((best, f) =>
        bucketRank[f.bucket as keyof typeof bucketRank] < bucketRank[best.bucket as keyof typeof bucketRank] ? f : best,
      ).bucket as CaseRow["earliest_beyond_bucket"]
    : null;

  return {
    instance_id: inst.instance_id,
    repo: inst.repo,
    cohort,
    m101_outcome: m101Outcome,
    m101_failure_reasons: m101Reasons,
    statement_chars: statement.length,
    v0_task_chars: v0.length,
    term_count: terms.length,
    terms_in_v0: findings.filter((f) => f.in_v0_task).length,
    terms_beyond_v0: beyond.length,
    has_evidence_beyond_v0: beyond.length > 0,
    earliest_beyond_bucket: earliest,
    beyond_contexts: beyondContexts,
    beyond_kinds: beyondKinds,
    code_like_tokens_360: codeLikeTokenCount(statement.slice(0, 360)),
    code_like_tokens_720: codeLikeTokenCount(statement.slice(0, 720)),
    code_like_tokens_1200: codeLikeTokenCount(statement.slice(0, 1200)),
    code_like_tokens_full: codeLikeTokenCount(statement),
    // Split discipline: per-term detail only for dev cases.
    findings: cohort === "dev" ? findings : null,
  };
}

// --- main -------------------------------------------------------------------------

interface SplitFile { readonly dev: string[]; readonly holdout: string[]; }

async function main(): Promise<void> {
  const dataPath = process.argv.includes("--swe-bench-data")
    ? process.argv[process.argv.indexOf("--swe-bench-data") + 1]!
    : DEFAULT_DATA;
  const swe = await loadSweBench(dataPath);
  const instances = [...swe.values()].sort((a, b) => a.instance_id.localeCompare(b.instance_id));

  const split = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m95_dev_holdout_split.json"), "utf8")) as SplitFile;
  const devSet = new Set(split.dev);

  const m101 = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m101_deterministic_scoreboard.detail.json"), "utf8"),
  ) as { rows: Array<{ instance_id: string; outcome: string | null; failure_reasons: string[]; generation_status: string }> };
  const m101ById = new Map(m101.rows.map((r) => [r.instance_id, r] as const));

  const rows: CaseRow[] = [];
  for (const inst of instances) {
    const base = m101ById.get(inst.instance_id);
    const row = auditInstance(
      inst,
      devSet.has(inst.instance_id) ? "dev" : "holdout",
      base?.outcome ?? null,
      base?.failure_reasons ?? [],
    );
    if (row !== null) rows.push(row);
  }

  const agg = (subset: readonly CaseRow[]) => {
    const withBeyond = subset.filter((r) => r.has_evidence_beyond_v0);
    const buckets: Record<string, number> = {};
    const contexts: Record<string, number> = {};
    const kinds: Record<string, number> = {};
    for (const r of subset) {
      if (r.earliest_beyond_bucket !== null) buckets[r.earliest_beyond_bucket] = (buckets[r.earliest_beyond_bucket] ?? 0) + 1;
      for (const [k, v] of Object.entries(r.beyond_contexts)) contexts[k] = (contexts[k] ?? 0) + v;
      for (const [k, v] of Object.entries(r.beyond_kinds)) kinds[k] = (kinds[k] ?? 0) + v;
    }
    const median = (xs: number[]) => {
      if (xs.length === 0) return 0;
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)]!;
    };
    return {
      n: subset.length,
      cases_with_evidence_beyond_v0: withBeyond.length,
      earliest_beyond_bucket_distribution: buckets,
      beyond_context_distribution: contexts,
      beyond_kind_distribution: kinds,
      median_statement_chars: median(subset.map((r) => r.statement_chars)),
      median_code_like_tokens: {
        chars_360: median(subset.map((r) => r.code_like_tokens_360)),
        chars_720: median(subset.map((r) => r.code_like_tokens_720)),
        chars_1200: median(subset.map((r) => r.code_like_tokens_1200)),
        full: median(subset.map((r) => r.code_like_tokens_full)),
      },
    };
  };

  const isMissClass = (r: CaseRow) => r.m101_outcome === "miss" || r.m101_outcome === "wrong_pivot";
  const byRepo: Record<string, ReturnType<typeof agg>> = {};
  for (const repo of [...new Set(rows.map((r) => r.repo))].sort()) {
    byRepo[repo] = agg(rows.filter((r) => r.repo === repo));
  }

  const out = {
    milestone: "M102",
    kind: "Task-derivation evidence-loss audit (text-level, read-only; gold vocabulary is audit-side only)",
    live_agents: false,
    docker: false,
    api_spend: false,
    n: rows.length,
    all: agg(rows),
    dev: agg(rows.filter((r) => r.cohort === "dev")),
    holdout: agg(rows.filter((r) => r.cohort === "holdout")),
    m101_miss_class_all: agg(rows.filter(isMissClass)),
    m101_miss_class_dev: agg(rows.filter((r) => isMissClass(r) && r.cohort === "dev")),
    m101_miss_class_holdout: agg(rows.filter((r) => isMissClass(r) && r.cohort === "holdout")),
    m101_lexical_mismatch: agg(rows.filter((r) => r.m101_failure_reasons.includes("lexical_mismatch"))),
    by_repo: byRepo,
    // Per-case rows: findings arrays are dev-only by construction.
    cases: rows,
  };
  await mkdir(RESULTS_ROOT, { recursive: true });
  await writeFile(
    path.join(RESULTS_ROOT, "stage5_m102_task_derivation_gap_audit.json"),
    JSON.stringify(out, null, 2) + "\n",
    "utf8",
  );
  process.stdout.write(
    `M102 evidence audit: ${rows.length} cases\n` +
    `ALL: beyond-V0 evidence in ${out.all.cases_with_evidence_beyond_v0}/${out.all.n}; buckets ${JSON.stringify(out.all.earliest_beyond_bucket_distribution)}\n` +
    `MISS-CLASS all: ${out.m101_miss_class_all.cases_with_evidence_beyond_v0}/${out.m101_miss_class_all.n}; buckets ${JSON.stringify(out.m101_miss_class_all.earliest_beyond_bucket_distribution)}\n` +
    `MISS-CLASS contexts: ${JSON.stringify(out.m101_miss_class_all.beyond_context_distribution)}; kinds: ${JSON.stringify(out.m101_miss_class_all.beyond_kind_distribution)}\n` +
    `noise (median code-like tokens, miss-class): ${JSON.stringify(out.m101_miss_class_all.median_code_like_tokens)}\n`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
