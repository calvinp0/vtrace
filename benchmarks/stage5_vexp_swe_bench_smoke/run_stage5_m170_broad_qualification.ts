/**
 * M170-E — the same window selection at corpus scale, on fresh indexes.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m170_broad_qualification.ts \
 *     --corpus broad100a|broad100b [--limit N]
 *
 * M170-C measured OBSERVED operations: ten whole-file reads that real agents
 * really issued, with the material they really went on to use. That is the
 * right measure and there are ten of them.
 *
 * This runs the same selection over 200 cases to answer the two questions n=10
 * cannot: how often does the mediation FIRE, and when it fires does the window
 * contain the lines the fix actually touches. The operation here is SIMULATED —
 * no agent issued it — and the preservation ground truth is the GOLD PATCH, not
 * an agent's own behaviour. It is therefore a different measure from M170-C's
 * and is never averaged with it.
 *
 * No live agents. No paid APIs. Reads fresh indexes only.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

import { openProductIndexDatabase } from "../../src/db/sqlite";
import { hybridRetrieve } from "../../src/retrieval/hybridRetrieval";
import { shapeSweQuery } from "../../src/capsule/sweQueryShaping";
import { listSymbolsForFile } from "../../src/db/repositories/symbolsRepository";
import { readIndexMeta } from "../../src/indexer/indexMeta";
import type { FilePath } from "../../src/domain/types";

import { gateIndexDerivation, expectedDerivation } from "./indexDerivationGate";
import {
  WindowPolicy, WINDOW_PARAMETERS, selectWindow, renderCatN, disclosureFor,
  type LineSpan, type RankedSpan,
} from "./m170Mediation";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const WORKSPACES = path.join(RESULTS, "workspaces");

const POLICIES: readonly WindowPolicy[] = [
  WindowPolicy.TopSymbol, WindowPolicy.TopSymbolScope, WindowPolicy.CoverTopK, WindowPolicy.CoverAllRanked,
];

const argv = process.argv.slice(2);
const corpus = argv[argv.indexOf("--corpus") + 1] ?? "broad100a";
const limitAt = argv.indexOf("--limit");
const limit = limitAt >= 0 ? Number(argv[limitAt + 1]) : null;

interface FixtureRow { instance_id: string; repo: string; workspace: string; task: string; expected_files: string[]; }

const CORPORA: Record<string, { fixture: string; workspaceRoot: string | null; datasets: readonly string[] }> = {
  broad100a: {
    fixture: "benchmarks/stage5_vexp_swe_bench_smoke/retrieval_eval.m155_broad_100.json",
    // M169 re-materialised A here because workspaces/cross_repo is not current-build authority.
    workspaceRoot: path.join(WORKSPACES, "m169_broad_a"),
    datasets: ["/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl"],
  },
  broad100b: {
    fixture: "benchmarks/stage5_vexp_swe_bench_smoke/retrieval_eval.m160_broad_b.json",
    workspaceRoot: null,
    datasets: [path.join(RESULTS, "_m160_corpus", "swe_bench_verified.jsonl")],
  },
};

const spec = CORPORA[corpus];
if (spec === undefined) throw new Error(`unknown corpus ${corpus}`);

const patches = new Map<string, string>();
for (const dataset of spec.datasets) {
  if (!existsSync(dataset)) continue;
  for (const line of readFileSync(dataset, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (typeof row.instance_id === "string" && typeof row.patch === "string") patches.set(row.instance_id, row.patch);
    } catch { /* not a dataset row */ }
  }
}

/**
 * Original-file line numbers a unified diff touches, per file.
 *
 * The `-` side of each hunk header is the base-commit numbering, which is what
 * a Read of the base tree returns. Using the `+` side would compare the window
 * against line numbers that do not exist in the file being read.
 */
function goldLinesByFile(patch: string): Map<string, LineSpan[]> {
  const byFile = new Map<string, LineSpan[]>();
  let current: string | null = null;
  for (const line of patch.split("\n")) {
    const fileHeader = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileHeader !== null) { current = fileHeader[1]!; continue; }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk === null || current === null) continue;
    const first = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    const spans = byFile.get(current) ?? [];
    spans.push({ first, last: first + count - 1 });
    byFile.set(current, spans);
  }
  return byFile;
}

const fixture = JSON.parse(readFileSync(path.join(ROOT, spec.fixture), "utf-8")) as FixtureRow[];
const cases = limit === null ? fixture : fixture.slice(0, limit);

const expected = await expectedDerivation();
const rows: Record<string, unknown>[] = [];
let done = 0;

for (const testCase of cases) {
  const workspace = spec.workspaceRoot === null
    ? path.join(ROOT, testCase.workspace)
    : path.join(spec.workspaceRoot, testCase.instance_id);

  const gate = await gateIndexDerivation(workspace, expected);
  if (!gate.valid) {
    rows.push({ instanceId: testCase.instance_id, status: "DERIVATION_INVALID", reason: gate.reason, detail: gate.detail });
    done += 1;
    continue;
  }
  const patch = patches.get(testCase.instance_id);
  if (patch === undefined) {
    rows.push({ instanceId: testCase.instance_id, status: "NO_GOLD_PATCH" });
    done += 1;
    continue;
  }
  const gold = goldLinesByFile(patch);
  const meta = await readIndexMeta(workspace);

  const db = openProductIndexDatabase(path.join(workspace, ".vtrace", "index.sqlite"));
  const started = performance.now();
  let retrieval;
  try {
    const shaped = shapeSweQuery({ problemStatement: testCase.task });
    retrieval = hybridRetrieve(db, { query: shaped.query, shaped, taskText: testCase.task, maxResults: 60 });
  } catch (error) {
    db.close();
    rows.push({ instanceId: testCase.instance_id, status: "RETRIEVAL_ERROR", detail: String(error) });
    done += 1;
    continue;
  }
  const rankMs = performance.now() - started;

  const fileRows: Record<string, unknown>[] = [];
  for (const relative of testCase.expected_files) {
    const onDisk = path.join(workspace, relative);
    if (!existsSync(onDisk)) {
      fileRows.push({ filePath: relative, status: "FILE_ABSENT_AT_BASE_COMMIT" });
      continue;
    }
    const fileLines = readFileSync(onDisk, "utf-8").split("\n");
    const totalLines = fileLines.length;
    const nativeCharacters = renderCatN(fileLines, { first: 1, last: totalLines }).length;
    const goldSpans = gold.get(relative) ?? [];

    const fileSymbols = listSymbolsForFile(db, relative as FilePath);
    const spans = new Map(fileSymbols.map((s) => [s.fqName, s]));
    const byId = new Map(fileSymbols.map((s) => [s.id as unknown as number, s]));
    const outermostScope = (fqName: string): LineSpan | undefined => {
      let current = spans.get(fqName);
      let scope: typeof current | undefined;
      while (current?.parentSymbolId !== null && current?.parentSymbolId !== undefined) {
        const parent = byId.get(current.parentSymbolId as unknown as number);
        if (parent === undefined || parent.fqName.endsWith("::<module>")) break;
        scope = parent; current = parent;
      }
      return scope === undefined ? undefined : { first: scope.startLine, last: scope.endLine };
    };

    const ranked: RankedSpan[] = [];
    retrieval.candidates.forEach((candidate, index) => {
      if (candidate.filePath !== relative) return;
      if (candidate.fqName.endsWith("::<module>")) return;
      const symbol = spans.get(candidate.fqName);
      if (symbol === undefined) return;
      const scope = outermostScope(candidate.fqName);
      ranked.push({
        fqName: candidate.fqName, rank: index, first: symbol.startLine, last: symbol.endLine,
        ...(scope === undefined ? {} : { scope }),
      });
    });

    const policies: Record<string, unknown> = {};
    for (const policy of POLICIES) {
      const window = selectWindow(policy, ranked, totalLines);
      if (window === null) { policies[policy] = { fired: false }; continue; }
      const mediated = renderCatN(fileLines, window).length + disclosureFor(relative, window, totalLines).length + 1;
      const containsAllGold = goldSpans.length > 0
        && goldSpans.every((span) => span.first >= window.first && span.last <= window.last);
      const containsAnyGold = goldSpans.some((span) => span.last >= window.first && span.first <= window.last);
      const hunksContained = goldSpans.filter((span) => span.first >= window.first && span.last <= window.last).length;
      policies[policy] = {
        fired: true, window,
        deliveredLines: window.last - window.first + 1,
        reductionShare: nativeCharacters === 0 ? 0 : Number((1 - mediated / nativeCharacters).toFixed(4)),
        savedCharacters: Math.max(0, nativeCharacters - mediated),
        goldSpansTotal: goldSpans.length,
        goldHunksContained: hunksContained,
        containsAllGold, containsAnyGold,
      };
    }

    fileRows.push({
      filePath: relative, status: "SIMULATED", totalLines, nativeCharacters,
        goldSpans, goldHunkCount: goldSpans.length, singleHunkFile: goldSpans.length === 1,
      rankedInFile: ranked.length,
      topRanked: ranked.slice(0, 3).map((r) => ({ fqName: r.fqName, rank: r.rank, first: r.first, last: r.last })),
      policies,
    });
  }
  db.close();

  rows.push({
    instanceId: testCase.instance_id, status: "MEASURED",
    workspace, indexVtraceCommit: meta?.vtrace_commit ?? null,
    indexerFingerprint: meta?.indexer_fingerprint ?? null,
    sourceRevision: meta?.repo_head ?? null,
    rankMs: Number(rankMs.toFixed(1)),
    files: fileRows,
  });
  done += 1;
  if (done % 10 === 0) console.log(`  [${done}/${cases.length}]`);
}

// ── aggregate ───────────────────────────────────────────────────────

const measured = rows.filter((r) => r.status === "MEASURED");
const simulatedFiles = measured.flatMap((r) => (r.files as Record<string, unknown>[]).filter((f) => f.status === "SIMULATED"));
const eligible = simulatedFiles.filter((f) => (f.totalLines as number) >= WINDOW_PARAMETERS.minimumFileLines);

const policySummary: Record<string, unknown> = {};
for (const policy of POLICIES) {
  const fired = simulatedFiles.filter((f) => ((f.policies as any)[policy]?.fired === true));
  const withGold = fired.filter((f) => ((f.policies as any)[policy].goldSpansTotal as number) > 0);
  const allGold = withGold.filter((f) => (f.policies as any)[policy].containsAllGold === true);
  const anyGold = withGold.filter((f) => (f.policies as any)[policy].containsAnyGold === true);
  const nativeChars = fired.reduce((n, f) => n + (f.nativeCharacters as number), 0);
  const hunksTotal = withGold.reduce((n, f) => n + ((f.policies as any)[policy].goldSpansTotal as number), 0);
  const hunksIn = withGold.reduce((n, f) => n + ((f.policies as any)[policy].goldHunksContained as number), 0);
  const singleHunk = withGold.filter((f) => f.singleHunkFile === true);
  const singleHunkContained = singleHunk.filter((f) => (f.policies as any)[policy].containsAllGold === true);
  const saved = fired.reduce((n, f) => n + ((f.policies as any)[policy].savedCharacters as number), 0);
  policySummary[policy] = {
    firedFiles: fired.length,
    fireRateOfSimulated: simulatedFiles.length === 0 ? 0 : Number((fired.length / simulatedFiles.length).toFixed(4)),
    fireRateOfEligible: eligible.length === 0 ? 0 : Number((fired.length / eligible.length).toFixed(4)),
    operationLocalReduction: nativeChars === 0 ? 0 : Number((saved / nativeChars).toFixed(4)),
    goldContainedFully: allGold.length,
    goldContainedPartially: anyGold.length - allGold.length,
    goldMissedEntirely: withGold.length - anyGold.length,
    goldFullContainmentRate: withGold.length === 0 ? 0 : Number((allGold.length / withGold.length).toFixed(4)),
    goldHunksTotal: hunksTotal,
    goldHunksContained: hunksIn,
    goldHunkContainmentRate: hunksTotal === 0 ? 0 : Number((hunksIn / hunksTotal).toFixed(4)),
    singleHunkFiles: singleHunk.length,
    singleHunkFilesContained: singleHunkContained.length,
    singleHunkContainmentRate: singleHunk.length === 0 ? 0 : Number((singleHunkContained.length / singleHunk.length).toFixed(4)),
  };
}

const report = {
  schemaVersion: "stage5.m170.broad-qualification.v1",
  milestone: "M170", workstream: "E", corpus,
  title: `Simulated read mediation over ${corpus}, fresh indexes`,
  measure: "SIMULATED_OPERATION_GOLD_PATCH_GROUND_TRUTH — not comparable with M170-C's observed-operation measure",
  method: {
    workspaceRoot: spec.workspaceRoot ?? "per-fixture workspace field",
    derivationGate: "benchmarks/.../indexDerivationGate.gateIndexDerivation, fail-closed",
    expectedIndexerFingerprint: expected.indexer_fingerprint,
    expectedIndexFormatVersion: expected.index_format_version,
    goldLineNumbering: "the '-' side of each hunk header: base-commit numbering, which is what a Read returns",
    windowParameters: WINDOW_PARAMETERS,
    liveSpendUsd: 0,
  },
  controls: {
    cases: cases.length,
    measured: measured.length,
    derivationInvalid: rows.filter((r) => r.status === "DERIVATION_INVALID").length,
    derivationInvalidDetail: rows.filter((r) => r.status === "DERIVATION_INVALID").slice(0, 10),
    retrievalErrors: rows.filter((r) => r.status === "RETRIEVAL_ERROR").length,
    noGoldPatch: rows.filter((r) => r.status === "NO_GOLD_PATCH").length,
    simulatedFiles: simulatedFiles.length,
    eligibleFiles: eligible.length,
    filesAbsentAtBaseCommit: measured.flatMap((r) => (r.files as Record<string, unknown>[])).filter((f) => f.status === "FILE_ABSENT_AT_BASE_COMMIT").length,
  },
  policySummary,
  perCase: rows,
};

const out = path.join(RESULTS, `stage5_m170_broad_qualification_${corpus}.json`);
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(`${corpus}: measured ${measured.length}/${cases.length}, derivation-invalid ${report.controls.derivationInvalid}, simulated files ${simulatedFiles.length} (eligible ${eligible.length})`);
for (const policy of POLICIES) {
  const s = policySummary[policy] as any;
  console.log(`  ${policy.padEnd(22)} fired=${s.firedFiles} (${(s.fireRateOfEligible * 100).toFixed(0)}% of eligible)  red=${(s.operationLocalReduction * 100).toFixed(1)}%  full=${s.goldContainedFully} partial=${s.goldContainedPartially} missed=${s.goldMissedEntirely}  fileContainment=${(s.goldFullContainmentRate * 100).toFixed(1)}%  hunkContainment=${(s.goldHunkContainmentRate * 100).toFixed(1)}%  single-hunk=${s.singleHunkFilesContained}/${s.singleHunkFiles}`);
}
console.log(`→ ${out}`);
