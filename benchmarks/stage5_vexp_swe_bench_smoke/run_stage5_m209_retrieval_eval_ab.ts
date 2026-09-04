/**
 * M209 — the deterministic retrieval-eval A/B: the predecessor worktree's
 * Stage 5R rows against this tree's, on the same reindexed workspaces, per
 * fixture. Reports what moved (top-1 pivot, expected-file / expected-symbol
 * best rank, hit classes) so an intentional delivery change is attributed row
 * by row rather than asserted. Read by run_stage5_m209_report.ts --phase final.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m209_retrieval_eval_ab.ts \
 *     --pre /home/calvin/bench/vtrace-m209/scratch/eval/pre --post /home/calvin/bench/vtrace-m209/scratch/eval/post
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const PRE = argOf("--pre", "/home/calvin/bench/vtrace-m209/scratch/eval/pre");
const POST = argOf("--post", "/home/calvin/bench/vtrace-m209/scratch/eval/post");
const FIXTURES = ["stage5_retrieval_eval_expanded", "stage5_retrieval_eval_cross_repo_30"];

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ""; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === "\"") { if (text[i + 1] === "\"") { cell += "\""; i += 1; } else quoted = false; }
      else cell += ch;
    } else if (ch === "\"") quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  const header = rows[0] ?? [];
  return rows.slice(1).filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, k) => [h, r[k] ?? ""])));
}

const out: any = { milestone: "M209", pre: PRE, post: POST, fixtures: {} };
for (const fixture of FIXTURES) {
  const pre = parseCsv(readFileSync(path.join(PRE, `${fixture}.csv`), "utf8"));
  const post = parseCsv(readFileSync(path.join(POST, `${fixture}.csv`), "utf8"));
  const byId = new Map(pre.map((r) => [r.instance_id, r]));
  const rows = post.map((p) => {
    const a = byId.get(p.instance_id!);
    if (a === undefined) return { instance_id: p.instance_id, status: "pre_missing" };
    const same = (k: string) => a[k] === p[k];
    return {
      instance_id: p.instance_id, repo: p.repo, intent: p.intent,
      evaluated: a.result !== "workspace_error" && p.result !== "workspace_error",
      top1Pivot: { pre: `${a.top_1_pivot_file}::${a.top_1_pivot_symbol}`, post: `${p.top_1_pivot_file}::${p.top_1_pivot_symbol}`, same: same("top_1_pivot_file") && same("top_1_pivot_symbol") },
      expectedFileRank: { pre: a.expected_file_best_rank, post: p.expected_file_best_rank },
      expectedSymbolRank: { pre: a.expected_symbol_best_rank, post: p.expected_symbol_best_rank },
      result: { pre: a.result, post: p.result }, missCategory: { pre: a.miss_category, post: p.miss_category },
      top1: { pre: a.contains_expected_file_top1, post: p.contains_expected_file_top1 }, top3: { pre: a.contains_expected_file_top3, post: p.contains_expected_file_top3 },
      pivotCount: { pre: a.pivot_count ?? null, post: p.pivot_count ?? null },
    };
  });
  const evaluated = rows.filter((r: any) => r.evaluated);
  const num = (v: string) => (v === "" || v === "missing" ? null : Number(v));
  const rankMove = (key: "expectedFileRank" | "expectedSymbolRank") => evaluated.reduce((h: any, r: any) => {
    const a = num(r[key].pre); const b = num(r[key].post);
    const k = a === b ? "same" : a === null ? "gained" : b === null ? "lost" : b < a ? "better" : "worse";
    h[k] = (h[k] ?? 0) + 1; return h;
  }, {});
  out.fixtures[fixture] = {
    rows: rows.length, evaluated: evaluated.length, workspaceErrors: rows.length - evaluated.length,
    top1PivotSame: evaluated.filter((r: any) => r.top1Pivot.same).length,
    top1PivotChanged: evaluated.filter((r: any) => !r.top1Pivot.same).map((r: any) => ({ id: r.instance_id, pre: r.top1Pivot.pre, post: r.top1Pivot.post })),
    resultSame: evaluated.filter((r: any) => r.result.pre === r.result.post).length,
    resultChanged: evaluated.filter((r: any) => r.result.pre !== r.result.post).map((r: any) => ({ id: r.instance_id, pre: r.result.pre, post: r.result.post })),
    top1FileHits: { pre: evaluated.filter((r: any) => r.top1.pre === "true").length, post: evaluated.filter((r: any) => r.top1.post === "true").length },
    top3FileHits: { pre: evaluated.filter((r: any) => r.top3.pre === "true").length, post: evaluated.filter((r: any) => r.top3.post === "true").length },
    expectedFileRank: rankMove("expectedFileRank"), expectedSymbolRank: rankMove("expectedSymbolRank"),
    rows_detail: rows,
  };
}
writeFileSync(path.join(RESULTS, "stage5_m209_retrieval_eval_ab.json"), `${JSON.stringify(out, null, 2)}\n`);
for (const [f, v] of Object.entries(out.fixtures) as [string, any][]) {
  console.log(`${f}: evaluated ${v.evaluated}/${v.rows}; top-1 pivot same ${v.top1PivotSame}; result same ${v.resultSame}; top1 file hits ${v.top1FileHits.pre}->${v.top1FileHits.post}; top3 ${v.top3FileHits.pre}->${v.top3FileHits.post}; file rank ${JSON.stringify(v.expectedFileRank)}; symbol rank ${JSON.stringify(v.expectedSymbolRank)}`);
}
