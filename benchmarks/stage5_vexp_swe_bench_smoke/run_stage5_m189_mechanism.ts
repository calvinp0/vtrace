/**
 * M189-B — post-edit decision points, candidate obligations, and mechanism specimens.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m189_mechanism.ts
 *
 * Question B of §4, asked only of the arms M189-A certified as able to answer it.
 *
 * THE ORDER OF OPERATIONS IS THE CONTROL. For every arm this script:
 *
 *   1. replays the recorded mutations against the BASE tree, stopping at a decision point;
 *   2. diffs the reconstructed tree against the base tree and attributes the changed line
 *      ranges to indexed symbols (§14 — attribution quality is recorded, never forced);
 *   3. asks the PRODUCT's own `getImpactGraph` what depends on those symbols;
 *   4. freezes a candidate obligation set built ONLY from the evidence slice;
 *   5. and only then opens the gold patch, to score a set it could not have influenced.
 *
 * Steps 1–4 receive a `DecisionPointEvidence` (m189Evidence.ts) with no gold field, no
 * outcome field, and no tool call at or after the decision ordinal. Step 5 is a different
 * function taking a different record. That separation is §11/§12 and it is the only reason
 * anything here counts as evidence rather than as a story told about known failures.
 *
 * IMPACT LIMITS ARE RAISED ON PURPOSE. The shipped default caps the graph at 64 edges, which
 * would silently make every candidate set look conveniently small. §35 requires measuring
 * candidate count BEFORE any analyst filtering, so the derivation runs with the caps lifted
 * and the resulting fan-out — including the embarrassing sizes — is what gets reported.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { getImpactGraph } from "../../src/impact/getImpactGraph";
import {
  decisionPoints,
  deriveI5Candidates,
  deriveI6Candidates,
  reconstructEditChronology,
  scoreCandidates,
  taskTermsFrom,
  type AuthoritativeRelation,
  type CandidateObligation,
  type CallCategory,
  type ChangedSymbol,
  type DecisionPointEvidence,
  type SymbolAttribution,
  type TraceCall,
} from "./m189Evidence";
import { deriveStructuredTaskFromProblemStatement } from "./stage5_task_derivation";
import { classifyValidationExecution, type ValidationEvidence } from "./validationExecution";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const TREES = "/home/calvin/.cache/m189_trees";

/**
 * §35's gold-hidden / outcome-hidden control, made EXECUTABLE rather than asserted. With
 * `M189_BLIND=1` the gold patch, the reference test patch and the grader verdict are erased
 * before anything is loaded, and the run writes only the candidate fingerprints. If the
 * derivation is genuinely blind, the fingerprints are identical to the sighted run's, and
 * `run_stage5_m189_controls.ts` compares them byte for byte. A structural argument that a
 * type has no gold field is worth having; a reproduction that the output does not move when
 * the field is removed is worth more.
 */
const BLIND = process.env.M189_BLIND === "1";
const BENCH_REPOS = "/home/calvin/code/vexp-swe-bench/.bench-repos";
const PATH_PREFIX = `${BENCH_REPOS}/`;

// ── dataset ─────────────────────────────────────────────────────────────────
const filesInPatch = (patch: string): readonly string[] => {
  const out = new Set<string>();
  for (const m of patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu)) out.add(m[2]!);
  for (const m of patch.matchAll(/^\+\+\+ b\/(\S+)$/gmu)) out.add(m[1]!);
  return [...out].filter((f) => f !== "dev/null").sort();
};


interface Instance {
  readonly repo: string; readonly baseCommit: string;
  readonly problemStatement: string;
  /** GOLD. Reachable only from the scoring pass. */
  readonly patch: string;
  /** GOLD. The reference TEST PATCH, whose files name the reference tests uniformly across
   *  repositories — FAIL_TO_PASS ids are path-shaped in some repos, dotted django labels in
   *  others and bare function names in sympy, so the ids alone cannot be compared. Scoring
   *  only; never an input to a derivation. */
  readonly referenceTestFiles: readonly string[];
}
const instances = new Map<string, Instance>();
for (const line of readFileSync(CORPUS, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const r = JSON.parse(line) as Record<string, string>;
  instances.set(r.instance_id!, {
    repo: r.repo!, baseCommit: r.base_commit!, problemStatement: r.problem_statement ?? "",
    patch: BLIND ? "" : (r.patch ?? ""),
    referenceTestFiles: BLIND ? [] : filesInPatch(r.test_patch ?? ""),
  });
}

// ── ledger from M189-A ──────────────────────────────────────────────────────

interface LedgerRow {
  readonly runLabel: string; readonly family: string; readonly rawDir: string;
  readonly instanceId: string; readonly repo: string; readonly resolved: boolean;
  readonly usableForI5: boolean; readonly usableForI6: boolean;
}
const ledger: LedgerRow[] = readFileSync(path.join(RESULTS, "stage5_m189_corpus_ledger.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim())
  .map((l) => JSON.parse(l) as LedgerRow)
  // In BLIND mode the grader verdict is erased too, so the control covers §35's
  // outcome-hidden requirement as well as its gold-hidden one.
  .map((r) => (BLIND ? { ...r, resolved: false } : r));

const treeFor = (instanceId: string): string | null => {
  const dir = path.join(TREES, instanceId);
  return existsSync(path.join(dir, ".vtrace/index.sqlite")) && existsSync(path.join(dir, ".m189_indexed")) ? dir : null;
};

// ── index authority ─────────────────────────────────────────────────────────

interface SymbolRow { readonly fqName: string; readonly kind: string; readonly startLine: number; readonly endLine: number }

class Authority {
  private readonly raw: Database;
  private readonly engine: ReturnType<typeof openIndexerDatabase>;
  private readonly impactCache = new Map<string, readonly AuthoritativeRelation[]>();
  private readonly testCache = new Map<string, readonly { file: string; viaFqName: string; edgeType: string }[]>();
  constructor(treeDir: string) {
    const dbPath = path.join(treeDir, ".vtrace/index.sqlite");
    this.raw = new Database(dbPath, { readonly: true });
    this.engine = openIndexerDatabase(dbPath);
  }
  fileIndexed(file: string): boolean {
    return this.raw.query("SELECT 1 FROM files WHERE path = ? LIMIT 1").get(file) !== null;
  }
  symbolsIntersecting(file: string, startLine: number, endLine: number): readonly SymbolRow[] {
    return this.raw
      .query(
        `SELECT s.fq_name AS fqName, s.kind AS kind, s.start_line AS startLine, s.end_line AS endLine
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE f.path = ? AND s.start_line <= ? AND s.end_line >= ?
         ORDER BY (s.end_line - s.start_line) ASC, s.fq_name ASC`,
      )
      .all(file, endLine, startLine) as SymbolRow[];
  }
  /** Exact test entrypoints the index relates to `fqn` at a given depth (§16, §35 fan-out). */
  testsAt(fqn: string, depth: number): readonly string[] {
    try {
      const r = getImpactGraph(this.engine, {
        symbolFqn: fqn, depth, format: "list", direction: "both",
        maxEdges: 100_000, maxPaths: 100_000, maxTokens: 100_000_000,
      }) as { ok: boolean; output?: Record<string, unknown> };
      if (!r.ok || r.output === undefined) return [];
      const rows = (r.output.tests ?? []) as readonly { filePath: string; strength: string }[];
      return [...new Set(rows.filter((t) => t.strength === "exact").map((t) => t.filePath))].sort();
    } catch { return []; }
  }

  /** Dependents of `fqn` at depth 1, with the shipped caps lifted so §35 can measure fan-out. */
  impact(fqn: string): { relations: readonly AuthoritativeRelation[]; tests: readonly { file: string; viaFqName: string; edgeType: string }[] } {
    const cached = this.impactCache.get(fqn);
    if (cached !== undefined) return { relations: cached, tests: this.testCache.get(fqn) ?? [] };
    let relations: AuthoritativeRelation[] = [];
    let tests: { file: string; viaFqName: string; edgeType: string }[] = [];
    try {
      const r = getImpactGraph(this.engine, {
        symbolFqn: fqn, depth: 1, format: "list", direction: "both",
        maxEdges: 100_000, maxPaths: 100_000, maxTokens: 100_000_000,
      }) as { ok: boolean; output?: Record<string, unknown> };
      if (r.ok && r.output !== undefined) {
        // `directRelations` is the product's own relation surface and it is the one that
        // states a DIRECTION. `nodes`/`edges` are documented as the legacy reverse view and
        // would have made the derivation blind to everything the change depends on.
        const direct = (r.output.directRelations ?? []) as readonly {
          kind: string; direction: string; strength: string;
          source: { path: string; symbol: string; kind: string };
          target: { path: string; symbol: string; kind: string };
        }[];
        for (const d of direct) {
          const other = d.direction === "incoming" ? d.source : d.target;
          if (other.symbol === fqn) continue;
          relations.push({
            fromFqName: fqn, toFqName: other.symbol, toFile: other.path, toKind: other.kind,
            edgeType: d.kind, strength: d.strength,
            direction: d.direction === "incoming" ? "dependent_of_change" : "dependency_of_change",
          });
        }
        const testRows = (r.output.tests ?? []) as readonly { filePath: string; strength: string }[];
        tests = testRows.filter((t) => t.strength === "exact").map((t) => ({ file: t.filePath, viaFqName: fqn, edgeType: "test_entrypoint" }));
      }
    } catch { relations = []; tests = []; }
    this.impactCache.set(fqn, relations);
    this.testCache.set(fqn, tests);
    return { relations, tests };
  }
  /**
   * POST-HOC DIAGNOSIS ONLY (§20 derivability). Is `file` reachable from `fqn` over indexed
   * edges within `maxDepth`, in EITHER direction? Answers "could the index have named this
   * file at all", which is a different question from "did the frozen derivation name it".
   * Never called from the derivation path.
   */
  reaches(fqn: string, file: string, maxDepth: number): { readonly reachable: boolean; readonly depth: number | null; readonly direction: string | null } {
    const start = this.raw.query("SELECT id FROM symbols WHERE fq_name = ?").all(fqn) as { id: string }[];
    if (start.length === 0) return { reachable: false, depth: null, direction: null };
    for (const dir of ["dependent", "dependency"] as const) {
      let frontier = new Set(start.map((r) => r.id));
      const seen = new Set(frontier);
      for (let depth = 1; depth <= maxDepth; depth += 1) {
        if (frontier.size === 0) break;
        const ids = [...frontier];
        const placeholders = ids.map(() => "?").join(",");
        const sql = dir === "dependent"
          ? `SELECT e.src_symbol_id AS id, f.path AS path FROM edges e
             JOIN symbols s ON s.id = e.src_symbol_id JOIN files f ON f.id = s.file_id
             WHERE e.dst_symbol_id IN (${placeholders})`
          : `SELECT e.dst_symbol_id AS id, f.path AS path FROM edges e
             JOIN symbols s ON s.id = e.dst_symbol_id JOIN files f ON f.id = s.file_id
             WHERE e.src_symbol_id IN (${placeholders})`;
        const rows = this.raw.query(sql).all(...ids) as { id: string; path: string }[];
        const next = new Set<string>();
        for (const r of rows) {
          if (r.path === file) return { reachable: true, depth, direction: dir };
          if (!seen.has(r.id)) { seen.add(r.id); next.add(r.id); }
        }
        frontier = next;
        if (seen.size > 60_000) break;
      }
    }
    return { reachable: false, depth: null, direction: null };
  }
  close(): void { this.raw.close(); }
}

// ── trace loading (shared shape with M189-A) ────────────────────────────────

interface RawCall {
  readonly index: number; readonly tool: string; readonly category: string;
  readonly path?: string | null; readonly command?: string | null; readonly output?: string | null;
  readonly args?: Record<string, unknown>;
}
const toCategory = (c: string): CallCategory => (c === "read" || c === "search" || c === "edit" ? c : "other");

function loadCalls(rawDir: string): readonly TraceCall[] {
  const abs = path.join(REPO_ROOT, rawDir);
  const withArgs = JSON.parse(readFileSync(path.join(abs, "_tool_calls.json"), "utf8")) as RawCall[];
  const woPath = path.join(abs, "_tool_calls_with_outputs.json");
  const withOutputs = existsSync(woPath) ? (JSON.parse(readFileSync(woPath, "utf8")) as RawCall[]) : [];
  const outById = new Map(withOutputs.map((c) => [c.index, c]));
  const calls: TraceCall[] = withArgs.map((c) => ({
    index: c.index, tool: c.tool, category: toCategory(c.category), path: c.path ?? null,
    command: outById.get(c.index)?.command ?? (typeof c.args?.command === "string" ? c.args.command : null),
    output: outById.get(c.index)?.output ?? null, args: c.args ?? {},
  }));
  const known = new Set(calls.map((c) => c.index));
  for (const o of withOutputs) {
    if (known.has(o.index)) continue;
    calls.push({ index: o.index, tool: o.tool, category: toCategory(o.category), path: o.path ?? null, command: o.command ?? null, output: o.output ?? null, args: {} });
  }
  return calls.sort((a, b) => a.index - b.index);
}

const finalPatchOf = (rawDir: string): string => {
  const abs = path.join(REPO_ROOT, rawDir);
  const jl = readdirSync(abs).find((x) => /^swebench-.*\.jsonl$/u.test(x));
  if (jl === undefined) return "";
  const first = readFileSync(path.join(abs, jl), "utf8").split("\n").find((l) => l.trim());
  if (first === undefined) return "";
  const row = JSON.parse(first) as { modelPatch?: string };
  return row.modelPatch ?? "";
};

// ── replay to an ordinal ────────────────────────────────────────────────────

const relOf = (p: string | null): string | null => {
  if (p === null || !p.startsWith(PATH_PREFIX)) return null;
  const rest = p.slice(PATH_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash < 0 ? null : rest.slice(slash + 1);
};

function baseBlob(treeDir: string, rel: string): string | null {
  const p = path.join(treeDir, rel);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

/**
 * The working tree as it stood strictly before `atIndex`. `skipped` is not decoration: a
 * decision point whose reconstruction dropped a mutation is not that agent's diff, and §9
 * warns specifically against inferring what an agent knew from a diff that is not the one it
 * had. Any nonzero count is carried onto the record and surfaced in the run summary.
 */
function treeAt(calls: readonly TraceCall[], atIndex: number, treeDir: string): { tree: ReadonlyMap<string, string>; applied: number; skipped: number } {
  const chronology = reconstructEditChronology(calls.filter((c) => c.index < atIndex));
  const tree = new Map<string, string>();
  let applied = 0; let skipped = 0;
  for (const op of chronology.ops) {
    const rel = relOf(op.file);
    if (rel === null) { skipped += 1; continue; }
    if (op.kind === "write") { tree.set(rel, op.newString ?? ""); applied += 1; continue; }
    let current = tree.get(rel);
    if (current === undefined) {
      const blob = baseBlob(treeDir, rel);
      if (blob === null) { skipped += 1; continue; }
      current = blob;
    }
    const needle = op.oldString ?? "";
    if (needle === "" || !current.includes(needle)) { skipped += 1; continue; }
    tree.set(rel, op.replaceAll ? current.split(needle).join(op.newString ?? "") : current.replace(needle, op.newString ?? ""));
    applied += 1;
  }
  return { tree, applied, skipped };
}

/** Base-side changed line ranges, from a real `git diff --no-index -U0`. */
function changedRanges(baseText: string | null, currentText: string, scratch: string): readonly { start: number; end: number }[] {
  const a = path.join(scratch, "a.txt"); const b = path.join(scratch, "b.txt");
  writeFileSync(a, baseText ?? ""); writeFileSync(b, currentText);
  let out = "";
  try {
    out = execFileSync("git", ["diff", "--no-index", "-U0", "--", a, b], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = typeof (e as { stdout?: string }).stdout === "string" ? (e as { stdout: string }).stdout : "";
  }
  const ranges: { start: number; end: number }[] = [];
  for (const m of out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+/gmu)) {
    const start = Number(m[1]); const len = m[2] === undefined ? 1 : Number(m[2]);
    ranges.push(len === 0 ? { start: Math.max(1, start), end: Math.max(1, start) + 1 } : { start, end: start + len - 1 });
  }
  return ranges;
}

/**
 * §14: a changed hunk gets the attribution the index actually supports. `module`,
 * `module_variable`, `module_constant` and `module_alias` are the kinds M140 gave the module
 * scope; a change that lands on one of them is a module-level edit and is labelled as such
 * rather than being promoted to a function it is not inside.
 */
function attributionOf(kind: string | null, leafCount: number, fileIndexed: boolean): SymbolAttribution {
  if (leafCount === 0) return fileIndexed ? "MODULE_LEVEL" : "UNMAPPED";
  if (leafCount > 1) return "MULTIPLE_OVERLAPPING";
  if (kind === "method") return "EXACT_METHOD";
  if (kind === "class") return "EXACT_CLASS";
  if (kind === "function") return "EXACT_FUNCTION";
  if (kind !== null && kind.startsWith("module")) return "MODULE_LEVEL";
  return "UNMAPPED";
}

// ── per-arm analysis ────────────────────────────────────────────────────────

/**
 * Test targets a shell command names, in the two shapes this corpus uses: a path
 * (`tests/model_fields/test_x.py`, pytest) and a dotted label (`model_fields.test_x`,
 * django's `runtests.py`). Bare sympy function names are not recoverable as files and are
 * deliberately not guessed.
 */
function testTargetsInCommand(command: string): readonly string[] {
  const out = new Set<string>();
  for (const m of command.matchAll(/([\w/\\.-]+\.py)/gu)) out.add(m[1]!);
  for (const m of command.matchAll(/(?:^|\s)((?:[A-Za-z_]\w*\.){1,}[A-Za-z_]\w*)(?=\s|$)/gu)) {
    const token = m[1]!;
    if (token.endsWith(".py") || /^(python|pytest|sys|os)\./u.test(token)) continue;
    out.add(token);
  }
  return [...out];
}

/** Do a run target and a reference test file denote the same test module? */
function shareTestKey(a: string, b: string): boolean {
  const keys = (x: string): Set<string> => {
    const norm = x.replace(/\.py$/u, "").replace(/\\/gu, "/").replace(/\./gu, "/").replace(/^\.?\//u, "");
    const parts = norm.split("/").filter((p) => p !== "" && p !== "tests" && p !== "test");
    const set = new Set<string>();
    for (let i = 0; i < parts.length; i += 1) set.add(parts.slice(i).join("/"));
    return set;
  };
  const ka = keys(a); const kb = keys(b);
  for (const k of ka) if (kb.has(k) && (k.includes("/") || k.startsWith("test_"))) return true;
  return false;
}

const exitCodeFromText = (o: string | null): number | null => {
  if (o === null) return null;
  const m = /^Exit code (\d{1,3})(?:\n|$)/u.exec(o);
  return m === null ? null : Number(m[1]);
};

interface DecisionRecord {
  readonly kind: string; readonly atIndex: number; readonly editsApplied: number;
  /** mutations the reconstruction could not apply at this ordinal; must be 0 to be faithful */
  readonly replaySkipped: number;
  readonly changedFiles: readonly string[];
  readonly changedSymbols: readonly ChangedSymbol[];
  readonly attributionCounts: Record<string, number>;
  readonly inspectedFileCount: number;
  readonly relationCount: number;
  readonly i5Dependents: number; readonly i5DependentsTaskRelevant: number; readonly i5Dependencies: number;
  readonly i6Candidates: number;
  readonly i6TestFilesDepth1: number;
  readonly i6TestFilesDepth2: number;
  /** POST-HOC: do the index-derived depth-1 test files include a FAIL_TO_PASS test file? */
  readonly i6NamesReferenceTestDepth1: boolean;
  readonly i6NamesReferenceTestDepth2: boolean;
  readonly i5DependentsScore: ReturnType<typeof scoreCandidates>;
  readonly i5DependentsTaskRelevantScore: ReturnType<typeof scoreCandidates>;
  readonly i5DependenciesScore: ReturnType<typeof scoreCandidates>;
  readonly i6Score: ReturnType<typeof scoreCandidates>;
  readonly i5TaskRelevantTop: readonly CandidateObligation[];
  readonly i6Top: readonly CandidateObligation[];
  /** POST-HOC (§17 success witness): candidate files the agent went on to inspect / edit. */
  readonly broadCandidatesLaterInspected: number;
  readonly broadCandidatesLaterEdited: number;
  /** sha256 over the FROZEN candidate sets; the control's comparison surface. */
  readonly candidateFingerprint: string;
}

interface ArmRecord {
  readonly runLabel: string; readonly rawDir: string; readonly family: string;
  readonly instanceId: string; readonly repo: string;
  readonly resolved: boolean; readonly usableForI5: boolean; readonly usableForI6: boolean;
  readonly finalPatchFiles: readonly string[];
  readonly goldFiles: readonly string[];
  readonly goldFilesMissedByFinalPatch: readonly string[];
  /** test files the agent demonstrably RAN (runner observed to start), repo-relative-ish */
  /** POST-HOC base rate for §17: files the agent opened AFTER its first edit that it had not
   *  opened before. Without it, a near-zero success witness is unreadable — it could mean the
   *  derivation names the wrong files, or that agents simply never look at anything new. */
  readonly novelFilesAfterFirstEdit: readonly string[];
  readonly testFilesRun: readonly string[];
  /** GOLD, scoring only: the reference FAIL_TO_PASS test files */
  readonly referenceTestFiles: readonly string[];
  readonly ranAnyReferenceTestFile: boolean;
  /** POST-HOC (§20). For each missed gold file, the shortest indexed relation to a symbol the
   *  agent had already changed at the LAST decision point. Diagnosis, never derivation. */
  readonly missedGoldReachability: readonly {
    readonly file: string; readonly reachable: boolean; readonly depth: number | null; readonly direction: string | null;
    /** §20 UTILITY: the agent had already opened this file before its last decision point, so
     *  an "inspect it" obligation would have told it something it already had. */
    readonly alreadyInspected: boolean;
  }[];
  readonly decisions: readonly DecisionRecord[];
}

const scratch = mkdtempSync(path.join(tmpdir(), "m189-diff-"));

function analyzeArm(row: LedgerRow, treeDir: string, authority: Authority): ArmRecord | null {
  const inst = instances.get(row.instanceId)!;
  const calls = loadCalls(row.rawDir);
  const chronology = reconstructEditChronology(calls);
  if (chronology.ops.length === 0) return null;

  // validation timeline (shared authority; no outcome input)
  const attemptIdx: number[] = []; const startedIdx: number[] = [];
  const validatedTargetsBefore = new Map<number, readonly string[]>();
  for (const c of calls) {
    const ev: ValidationEvidence = {
      tool: c.tool, command: c.command, output: c.output, success: null,
      exitCode: exitCodeFromText(c.output), exitCodeSource: "output_prefix", truncated: false,
    };
    const rec = classifyValidationExecution(ev);
    if (rec === null) continue;
    attemptIdx.push(c.index);
    if (rec.runnerStarted === true) {
      startedIdx.push(c.index);
      const named = testTargetsInCommand(c.command ?? "");
      validatedTargetsBefore.set(c.index, named);
    }
  }

  const dps = decisionPoints({ calls, chronology, validationAttemptIndices: attemptIdx, validationStartedIndices: startedIdx });
  const taskText = deriveStructuredTaskFromProblemStatement(inst.problemStatement).taskText;
  const taskTerms = taskTermsFrom(taskText);

  const decisions: DecisionRecord[] = [];
  for (const dp of dps) {
    const { tree, skipped: replaySkipped } = treeAt(calls, dp.atIndex, treeDir);
    if (tree.size === 0) continue;
    const changedFiles = [...tree.keys()].sort();

    const changedSymbols: ChangedSymbol[] = [];
    const attributionCounts: Record<string, number> = {};
    for (const file of changedFiles) {
      const base = baseBlob(treeDir, file);
      const indexed = authority.fileIndexed(file);
      for (const range of changedRanges(base, tree.get(file)!, scratch)) {
        const hits = authority.symbolsIntersecting(file, range.start, range.end);
        const leaves = hits.filter((s) => !hits.some((o) => o !== s && o.startLine >= s.startLine && o.endLine <= s.endLine && (o.startLine !== s.startLine || o.endLine !== s.endLine)));
        const attribution = attributionOf(leaves[0]?.kind ?? null, leaves.length, indexed);
        attributionCounts[attribution] = (attributionCounts[attribution] ?? 0) + 1;
        if (leaves.length === 0) {
          changedSymbols.push({ file, fqName: null, kind: null, attribution, anchorLine: range.start });
        } else {
          for (const leaf of leaves) changedSymbols.push({ file, fqName: leaf.fqName, kind: leaf.kind, attribution, anchorLine: range.start });
        }
      }
    }

    const relations: AuthoritativeRelation[] = [];
    const relatedTests: { file: string; viaFqName: string; edgeType: string }[] = [];
    const changedFqns = [...new Set(changedSymbols.map((s) => s.fqName).filter((f): f is string => f !== null))];
    for (const fq of changedFqns) {
      const { relations: rel, tests } = authority.impact(fq);
      relations.push(...rel);
      relatedTests.push(...tests);
    }
    const testFilesD1 = [...new Set(changedFqns.flatMap((fq) => authority.testsAt(fq, 1)))].sort();
    const testFilesD2 = [...new Set(changedFqns.flatMap((fq) => authority.testsAt(fq, 2)))].sort();

    const before = calls.filter((c) => c.index < dp.atIndex);
    const inspectedFiles = [...new Set(
      before.flatMap((c) => {
        const fromArgs = typeof c.args.file_path === "string" ? [c.args.file_path] : [];
        const fromPath = c.path !== null ? [c.path] : [];
        return [...fromArgs, ...fromPath].map(relOf).filter((f): f is string => f !== null && /\.[A-Za-z0-9]+$/u.test(f));
      }),
    )].sort();
    const validated = [...new Set(startedIdx.filter((i) => i < dp.atIndex).flatMap((i) => validatedTargetsBefore.get(i) ?? []))];

    const evidence: DecisionPointEvidence = {
      atIndex: dp.atIndex, kind: dp.kind, taskTerms,
      changedFiles, changedSymbols, inspectedFiles, relations,
      relatedTestFiles: relatedTests, validatedTargets: validated,
      anyRunnerStartedBefore: startedIdx.some((i) => i < dp.atIndex),
    };

    // ---- candidate sets are FROZEN here. Gold and the future enter only below. ----
    const broad = deriveI5Candidates(evidence, "DEPENDENTS");
    const relevant = deriveI5Candidates(evidence, "DEPENDENTS_TASK_RELEVANT");
    const dependencies = deriveI5Candidates(evidence, "DEPENDENCIES");
    const i6 = deriveI6Candidates(evidence);

    const after = calls.filter((c) => c.index >= dp.atIndex);
    const laterInspected = new Set(
      after.flatMap((c) => {
        const fromArgs = typeof c.args.file_path === "string" ? [c.args.file_path] : [];
        const fromPath = c.path !== null ? [c.path] : [];
        return [...fromArgs, ...fromPath].map(relOf).filter((f): f is string => f !== null);
      }),
    );
    const laterEdited = new Set(
      reconstructEditChronology(after).ops.map((o) => relOf(o.file)).filter((f): f is string => f !== null),
    );

    const goldFiles = filesInPatch(inst.patch);
    const finalFiles = filesInPatch(finalPatchOf(row.rawDir));
    const common = { goldFiles, finalPatchFiles: finalFiles, resolved: row.resolved };
    const fingerprint = createHash("sha256").update(JSON.stringify({
      at: dp.atIndex, kind: dp.kind,
      dependents: broad.map((c) => `${c.targetFile}::${c.targetFqName}::${c.edgeType}`),
      relevant: relevant.map((c) => `${c.targetFile}::${c.targetFqName}::${c.edgeType}`),
      dependencies: dependencies.map((c) => `${c.targetFile}::${c.targetFqName}::${c.edgeType}`),
      i6: i6.map((c) => `${c.targetFile}::${c.edgeType}`),
      testsD1: testFilesD1, testsD2: testFilesD2,
      changedSymbols: changedSymbols.map((c) => `${c.file}::${c.fqName}::${c.attribution}`),
    })).digest("hex");

    decisions.push({
      candidateFingerprint: fingerprint,
      kind: dp.kind, atIndex: dp.atIndex, editsApplied: dp.editsApplied, replaySkipped,
      changedFiles, changedSymbols, attributionCounts,
      inspectedFileCount: inspectedFiles.length, relationCount: relations.length,
      i5Dependents: new Set(broad.map((c) => c.targetFile)).size,
      i5DependentsTaskRelevant: new Set(relevant.map((c) => c.targetFile)).size,
      i5Dependencies: new Set(dependencies.map((c) => c.targetFile)).size,
      i6Candidates: i6.length,
      i6TestFilesDepth1: testFilesD1.length,
      i6TestFilesDepth2: testFilesD2.length,
      i6NamesReferenceTestDepth1: testFilesD1.some((f) => inst.referenceTestFiles.includes(f)),
      i6NamesReferenceTestDepth2: testFilesD2.some((f) => inst.referenceTestFiles.includes(f)),
      i5DependentsScore: scoreCandidates({ candidates: broad, ...common }),
      i5DependentsTaskRelevantScore: scoreCandidates({ candidates: relevant, ...common }),
      i5DependenciesScore: scoreCandidates({ candidates: dependencies, ...common }),
      i6Score: scoreCandidates({ candidates: i6, ...common }),
      i5TaskRelevantTop: relevant.slice(0, 8),
      i6Top: i6.slice(0, 8),
      broadCandidatesLaterInspected: [...new Set([...broad, ...dependencies].map((c) => c.targetFile))].filter((f) => laterInspected.has(f)).length,
      broadCandidatesLaterEdited: [...new Set([...broad, ...dependencies].map((c) => c.targetFile))].filter((f) => laterEdited.has(f)).length,
    });
  }
  if (decisions.length === 0) return null;

  const goldFiles = filesInPatch(inst.patch);
  const finalFiles = filesInPatch(finalPatchOf(row.rawDir));
  const missed = goldFiles.filter((f) => !finalFiles.includes(f));
  const lastChanged = [...new Set(decisions[decisions.length - 1]!.changedSymbols.map((s) => s.fqName).filter((f): f is string => f !== null))];
  const inspectedAnywhere = new Set(
    calls.flatMap((c) => {
      const fromArgs = typeof c.args.file_path === "string" ? [c.args.file_path] : [];
      const fromPath = c.path !== null ? [c.path] : [];
      return [...fromArgs, ...fromPath].map(relOf).filter((f): f is string => f !== null);
    }),
  );
  const missedGoldReachability = missed.map((file) => {
    let best: { reachable: boolean; depth: number | null; direction: string | null } = { reachable: false, depth: null, direction: null };
    for (const fq of lastChanged) {
      const r = authority.reaches(fq, file, 3);
      if (r.reachable && (best.depth === null || r.depth! < best.depth)) best = r;
    }
    return { file, ...best, alreadyInspected: inspectedAnywhere.has(file) };
  });
  const firstEditIndex = chronology.ops[0]!.callIndex;
  const openedBefore = new Set<string>(); const openedAfter = new Set<string>();
  for (const c of calls) {
    const named = [typeof c.args.file_path === "string" ? c.args.file_path : null, c.path]
      .map(relOf).filter((f): f is string => f !== null);
    for (const f of named) (c.index <= firstEditIndex ? openedBefore : openedAfter).add(f);
  }
  const novelFilesAfterFirstEdit = [...openedAfter].filter((f) => !openedBefore.has(f)).sort();

  const testFilesRun = [...new Set([...validatedTargetsBefore.values()].flat())].sort();
  return {
    runLabel: row.runLabel, rawDir: row.rawDir, family: row.family, instanceId: row.instanceId, repo: row.repo,
    resolved: row.resolved, usableForI5: row.usableForI5, usableForI6: row.usableForI6,
    finalPatchFiles: finalFiles, goldFiles,
    goldFilesMissedByFinalPatch: missed,
    novelFilesAfterFirstEdit,
    testFilesRun,
    referenceTestFiles: inst.referenceTestFiles,
    ranAnyReferenceTestFile: testFilesRun.some((t) => inst.referenceTestFiles.some((g) => shareTestKey(t, g))),
    missedGoldReachability,
    decisions,
  };
}

// ── run ─────────────────────────────────────────────────────────────────────

/**
 * The stratum is EVERY I5-usable arm whose instance has an indexed base tree — not M183 plus
 * the I6-usable arms, which is where this analysis started. The boundary had to move because
 * §17's success witness is a search over successes of the SAME task, and the first specimen
 * this milestone found (sphinx-7462) has eleven resolved arms in milestones the narrower
 * stratum excluded. A success-witness search that cannot see the successes is not one.
 */
const targets = ledger.filter((r) => r.usableForI5 && treeFor(r.instanceId) !== null);
const byInstance = new Map<string, LedgerRow[]>();
for (const r of targets) {
  const list = byInstance.get(r.instanceId) ?? [];
  list.push(r);
  byInstance.set(r.instanceId, list);
}

const records: ArmRecord[] = [];
const skipped: { runLabel: string; why: string }[] = [];
for (const [instanceId, rows] of [...byInstance.entries()].sort()) {
  const treeDir = treeFor(instanceId);
  if (treeDir === null) {
    for (const r of rows) skipped.push({ runLabel: r.runLabel, why: "NO_INDEX_BUILT" });
    continue;
  }
  const authority = new Authority(treeDir);
  for (const r of rows) {
    try {
      const rec = analyzeArm(r, treeDir, authority);
      if (rec === null) skipped.push({ runLabel: r.runLabel, why: "NO_RECONSTRUCTABLE_DECISION_POINT" });
      else records.push(rec);
    } catch (e) {
      skipped.push({ runLabel: r.runLabel, why: `ERROR:${(e as Error).message.slice(0, 120)}` });
    }
  }
  authority.close();
}
rmSync(scratch, { recursive: true, force: true });

// Keyed on rawDir, not runLabel: one label can carry several raw conditions, and keying on
// the label silently merged two arms into one row in the control's comparison.
const fingerprints = records.flatMap((r) => r.decisions.map((d) => `${r.rawDir}\t${d.atIndex}\t${d.candidateFingerprint}`)).sort();
if (BLIND) {
  writeFileSync(path.join(RESULTS, "stage5_m189_candidate_fingerprints.blind.txt"), `${fingerprints.join("\n")}\n`);
} else {
  writeFileSync(path.join(RESULTS, "stage5_m189_decision_points.jsonl"), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  writeFileSync(path.join(RESULTS, "stage5_m189_skipped.json"), `${JSON.stringify({ skipped, count: skipped.length }, null, 2)}\n`);
  writeFileSync(path.join(RESULTS, "stage5_m189_candidate_fingerprints.sighted.txt"), `${fingerprints.join("\n")}\n`);
}

process.stdout.write(
  [
    `M189-B decision points${BLIND ? " (BLIND: gold and outcome erased)" : ""}`,
    `  arms analysed        ${records.length}`,
    `  arms skipped         ${skipped.length}`,
    `  decision points      ${records.reduce((a, r) => a + r.decisions.length, 0)}`,
    `  I5 arms              ${records.filter((r) => r.usableForI5).length}`,
    `  I6 arms              ${records.filter((r) => r.usableForI6).length}`,
    `  DPs with an unfaithful partial replay  ${records.flatMap((r) => r.decisions).filter((d) => d.replaySkipped > 0).length}`,
    ``,
  ].join("\n"),
);
