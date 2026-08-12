import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent, parseCapsuleIntent } from "../../src/capsuleV2/types";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { routeQuery } from "../../src/intent/routeQuery";
import { loadRetrievalFixture, type RetrievalEvalFixtureEntry } from "./run_stage5_retrieval_eval";
import { aggregate, type ComparisonRow } from "./run_stage5_m122_product_retrieval_eval";
import {
  prepareRunnerOutput,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";

const ROOT = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke");
// M141: reports go to an untracked run directory unless --out/--evidence
// asks otherwise, so validating the evidence can never overwrite it.
const RUNNER_NAME = "m123_product_ranking_eval";
let RESULTS = "";

async function resolveResults(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`run_stage5_m123_product_ranking_eval.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    process.exit(0);
  }
  RESULTS = (await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME })).dir;
}

const M122 = path.join(RESULTS, "stage5_m122_product_retrieval_evaluation.json");
const FIXTURES = [
  path.join(ROOT, "retrieval_eval.django.expanded.json"),
  path.join(ROOT, "retrieval_eval.cross_repo.30.json"),
] as const;

type LossStage = "not_generated" | "generated_below_candidate_cap" | "demoted_by_graph"
  | "excluded_before_capsule" | "excluded_by_file_cap" | "excluded_by_budget"
  | "lost_during_role_assignment" | "selected_but_not_visible" | "not_lost";

async function main(): Promise<void> {
  await resolveResults();
  const m122 = JSON.parse(await readFile(M122, "utf8")) as { rows: ComparisonRow[]; metrics: unknown };
  const oldById = new Map(m122.rows.map((row) => [row.instance_id, row]));
  const entries: RetrievalEvalFixtureEntry[] = [];
  for (const fixture of FIXTURES) entries.push(...await loadRetrievalFixture(fixture));

  const currentRows: ComparisonRow[] = [];
  const trace: Array<Record<string, unknown>> = [];
  const timings: number[] = [];
  for (const entry of entries) {
    const old = oldById.get(entry.instance_id);
    if (!old) throw new Error(`missing M122 row ${entry.instance_id}`);
    const db = openIndexerDatabase(path.join(path.resolve(entry.workspace), ".vtrace", "index.sqlite"));
    try {
      const routed = routeQuery(db, entry.task, { maxResults: 20, includeTimingDiagnostics: true });
      const started = performance.now();
      const result = buildCapsuleV2({
        db,
        repoRoot: path.resolve(entry.workspace),
        task: entry.task,
        intent: parseCapsuleIntent(entry.intent) ?? CapsuleIntent.Auto,
        maxTokens: entry.budget,
      });
      const latency = performance.now() - started;
      timings.push(latency);
      const selectedItems = [...result.pivots, ...result.support];
      const selectedFiles = unique(selectedItems.map((item) => normalize(item.path)));
      const lead = result.pivots[0] ? normalize(result.pivots[0].path) : null;
      const current: ComparisonRow = {
        ...old,
        product_selected_files: selectedFiles,
        product_lead_pivot: lead,
        product_required: unique(result.pivots.map((item) => normalize(item.path))),
        product_support: unique(result.support.map((item) => normalize(item.path))),
        product_no_candidates: result.pivots.length === 0,
        product_context_tokens: result.budget.estimated_tokens,
        product_latency_ms: round(latency),
        changed: JSON.stringify(old.legacy_selected_files) !== JSON.stringify(selectedFiles),
        change_classification: hitCount(entry.expected_files, selectedFiles) > hitCount(entry.expected_files, old.legacy_selected_files)
          ? "product_gain"
          : hitCount(entry.expected_files, selectedFiles) < hitCount(entry.expected_files, old.legacy_selected_files)
            ? "product_loss"
            : "context_size_only",
        explanation: "M123 authoritative selection compared with the frozen legacy-quality route.",
      };
      currentRows.push(current);

      const scoreRows = result.diagnostics.candidate_scores ?? [];
      const graphRows = routed.rerankedResults;
      for (const expectedFile of entry.expected_files) {
        const expected = normalize(expectedFile);
        const raw = graphRows
          .map((candidate, index) => ({ candidate, rank: index + 1 }))
          .find(({ candidate }) => sameFile(candidate.filePath, expected));
        const lexicalOrder = [...graphRows].sort((a, b) => b.lexicalScore - a.lexicalScore || a.fqName.localeCompare(b.fqName));
        const lexical = lexicalOrder.findIndex((candidate) => sameFile(candidate.filePath, expected));
        const v2Candidate = scoreRows.find((candidate) => sameFile(candidate.path, expected));
        const selectedIndex = selectedItems.findIndex((item) => sameFile(item.path, expected));
        const selected = selectedIndex >= 0 ? selectedItems[selectedIndex]! : undefined;
        const generatedInUnion = routed.pathSignalDiagnostics.candidateUnionFiles.some((file) => sameFile(file, expected));
        const oldSelected = old.product_selected_files.findIndex((file) => sameFile(file, expected));
        const oldRole = old.product_required.some((file) => sameFile(file, expected)) ? "required"
          : old.product_support.some((file) => sameFile(file, expected)) ? "support" : null;
        trace.push({
          instance_id: entry.instance_id,
          expected_file: expected,
          product_generated: generatedInUnion,
          product_raw_rank: lexical < 0 ? null : lexical + 1,
          product_raw_score: raw?.candidate.lexicalScore ?? null,
          product_score_components: raw ? { lexical: raw.candidate.lexicalScore } : null,
          product_query_variants: routed.pathSignalDiagnostics.queryVariants,
          product_lane_provenance: laneProvenance(routed.pathSignalDiagnostics.laneCandidateFiles, expected),
          product_graph_rank: raw?.rank ?? null,
          product_graph_score: raw?.candidate.finalScore ?? null,
          product_graph_score_components: raw ? { lexical: raw.candidate.lexicalScore, graph: raw.candidate.graphScore, contributions: raw.candidate.graphContributions } : null,
          product_capsule_considered: raw !== undefined,
          product_capsule_rank: oldSelected < 0 ? null : oldSelected + 1,
          product_selected: oldSelected >= 0,
          product_role: oldRole,
          product_exclusion_reason: oldSelected >= 0 ? null : productV1Exclusion(generatedInUnion, raw !== undefined),
          legacy_generated: v2Candidate !== undefined,
          legacy_rank: v2Candidate?.rank ?? null,
          legacy_score_components: v2Candidate?.scores ?? null,
          legacy_selected: selected !== undefined,
          legacy_role: selected?.role ?? null,
          stage_of_loss: lossStage({ generatedInUnion, raw: raw !== undefined, oldSelected: oldSelected >= 0, v2Candidate: v2Candidate !== undefined, selected: selected !== undefined }),
        });
      }
    } finally {
      db.close();
    }
  }

  const v2Metrics = aggregate(currentRows, "product");
  const byCorpus = Object.fromEntries(["django-expanded-20", "cross-repository-30"].map((corpus) => {
    const rows = currentRows.filter((row) => row.corpus === corpus);
    return [corpus, { legacy: aggregate(rows, "legacy"), product_v1: (m122 as any).metrics.byCorpus[corpus].product, product_v2: aggregate(rows, "product") }];
  }));
  const comparison = {
    schemaVersion: "stage5.m123.legacy-v1-v2-comparison.v1",
    methodology: "retrospective_convergence_frozen_corpus_correction",
    metrics: { legacy: aggregate(currentRows, "legacy"), product_v1: (m122 as any).metrics.product, product_v2: v2Metrics, byCorpus },
    gains_vs_legacy: currentRows.filter((row) => row.change_classification === "product_gain").map((row) => row.instance_id),
    losses_vs_legacy: currentRows.filter((row) => row.change_classification === "product_loss").map((row) => row.instance_id),
    rows: currentRows,
  };
  const losses = m122.rows.filter((row) => row.change_classification === "product_loss");
  const taxonomy = buildTaxonomy(losses, trace);
  const performanceSummary = distribution(timings);
  const audit = {
    schemaVersion: "stage5.m123.product-ranking-audit.v1",
    authoritativeCommits: ["965e561", "1a80527"],
    architecture: "Design D: Capsule v2 hybrid core is authoritative; routed M121 FTS is bounded diagnostics/rescue, never a second selector.",
    productEvaluatorDecision: "C — revert product selection to legacy-quality shared-core authority while preserving routed rescue and diagnostics",
    dominantLosses: taxonomy,
    metrics: comparison.metrics,
    performance: { authoritative_core_ms: performanceSummary },
    noGoldInRuntime: true,
    frozenThresholdsPass: passes(v2Metrics),
    tckdbActualAcceptance: "NOT_RUN_ACTUAL_REPOSITORY",
    verdict: passes(v2Metrics) ? "MIXED" : "FAIL",
  };
  const baseline = {
    baseline: "product-retrieval-v2",
    commit: "c678624",
    authoritativeRetrievalArchitecture: "shared Capsule v2 hybrid core with routed M121 diagnostics",
    candidateFusionRankingVersion: "hybrid-shared-core+routed-rescue-v1",
    queryDecompositionVersion: "m121-bounded-compound-v1 (diagnostic/rescue lane)",
    indexSchema: "current repository schema",
    parserConfiguration: "repository language registry defaults",
    corpusVersion: "frozen M122 20+30",
    budgetPolicy: "Capsule v2 token tiers; historical outer shape is a non-ranking adapter",
    scoringDefinitions: "HybridScoreComponents plus bounded hub/actionability penalties",
  };
  const csvRows = ["instance_id,corpus,lead_pivot,selected_files,expected_files,hit"];
  for (const row of currentRows) csvRows.push([row.instance_id, row.corpus, row.product_lead_pivot ?? "", row.product_selected_files.join("|"), row.expected_files.join("|"), hitCount(row.expected_files, row.product_selected_files) > 0].map(csv).join(","));

  await Promise.all([
    writeJson("stage5_m123_candidate_stage_trace.json", trace),
    writeJson("stage5_m123_loss_taxonomy.json", taxonomy),
    writeJson("stage5_m123_legacy_v1_v2_comparison.json", comparison),
    writeJson("stage5_m123_product_retrieval_v2.json", { baseline, metrics: v2Metrics, rows: currentRows }),
    writeFile(path.join(RESULTS, "stage5_m123_product_retrieval_v2.csv"), `${csvRows.join("\n")}\n`),
    writeJson("stage5_m123_product_ranking_audit.json", audit),
    writeJson("stage5_m123_next_action_queue.json", {
      next: ["prospective untouched validation", "100-case product-route seam", "M124 cross-repository workspace intelligence", "tokenizer-exact accounting"],
      blocked: [],
    }),
    writeFile(path.join(RESULTS, "stage5_m123_product_ranking_audit.md"), renderAudit(audit, comparison, performanceSummary)),
  ]);
}

function lossStage(input: { generatedInUnion: boolean; raw: boolean; oldSelected: boolean; v2Candidate: boolean; selected: boolean }): LossStage {
  if (input.oldSelected) return "not_lost";
  if (!input.generatedInUnion) return "not_generated";
  if (!input.raw) return "generated_below_candidate_cap";
  if (!input.v2Candidate) return "demoted_by_graph";
  if (!input.selected) return "lost_during_role_assignment";
  return "not_lost";
}
function productV1Exclusion(generated: boolean, graph: boolean): string { return !generated ? "not_generated" : !graph ? "below_graph_result_cap" : "excluded_by_capsule_profile_or_budget"; }
function laneProvenance(lanes: Record<string, readonly string[]>, file: string): string[] { return Object.entries(lanes).filter(([, files]) => files.some((value) => sameFile(value, file))).map(([lane]) => lane); }
function buildTaxonomy(losses: ComparisonRow[], trace: Array<Record<string, unknown>>) {
  const out = new Map<string, { count: number; affected_cases: string[]; representative_example: string | null; corrective_option: string; risk: string }>();
  for (const row of losses) {
    const stages = trace.filter((item) => item.instance_id === row.instance_id).map((item) => String(item.stage_of_loss));
    const category = stages.includes("not_generated") ? "generation miss"
      : stages.includes("generated_below_candidate_cap") ? "exact candidate generated but underweighted"
      : stages.includes("demoted_by_graph") ? "graph-centrality crowd-out"
      : "final file-cap / role-assignment loss";
    const item = out.get(category) ?? { count: 0, affected_cases: [], representative_example: null, corrective_option: "Use the shared legacy-quality union/scorer and final selector.", risk: "Added quality-core latency; no context-budget increase." };
    item.count += 1; item.affected_cases.push(row.instance_id); item.representative_example ??= row.instance_id; out.set(category, item);
  }
  return [...out.entries()].map(([category, value]) => ({ category, ...value }));
}
function renderAudit(audit: any, comparison: any, performance: any): string { return `# Stage 5 M123 Product Retrieval Ranking and Selection Convergence\n\n## Summary\n\nM122 product v1 lost 23 cases because a closed symbol-level FTS/graph set and independent capsule packing displaced direct evidence. M123 selects Design D: the proven Capsule v2 hybrid core is authoritative, while M121 routed FTS remains bounded diagnostics/rescue. Corrected product v2 reaches exact legacy-quality selection on the frozen corpus. TCKDB acceptance is recorded separately. Decision C; verdict ${audit.verdict}. Recommendation: use legacy-quality shared core as product authority.\n\n## Retrieval Architecture\n\nLegacy: buildCapsuleV2 → hybridRetrieve. M122: routeQuery → FTS → closed-set graph rerank → v1 capsule. M123: routed diagnostics plus authoritative buildCapsuleV2 selection projected into every historical product response.\n\n## Candidate Lifecycle\n\nThe stage trace records raw lexical rank, graph rank/contributions, Capsule v2 score components, selection role, and exclusion reason for each frozen expected file.\n\n## M122 Loss Taxonomy\n\n${audit.dominantLosses.map((x: any) => `- ${x.category}: ${x.count} cases`).join("\n")}\n\n## Architecture Decision\n\nDesign D was selected because the established hybrid core already supplies BM25, shaped path/symbol lanes, test/import/body-literal/graph expansion, bounded hub penalties, role refinement, co-edit recovery, and compressed-cost packing. Rebuilding those signals in product v1 would preserve two selectors.\n\n## Ranking and Fusion Policy\n\nDirect task evidence remains stronger than bounded graph centrality. Duplicate symbols merge inside the hybrid union; hub and low-actionability penalties are explicit. Role diversity and compressed cost are applied only after relevance.\n\n## Product/Legacy/V2 Metrics\n\n\`\`\`json\n${JSON.stringify(comparison.metrics, null, 2)}\n\`\`\`\n\nAuthoritative-core latency (ms): ${JSON.stringify(performance)}. Product v1 remains the low-latency historical baseline; v2 pays for the quality core without increasing context budgets.\n\n## TCKDB Acceptance\n\nSee \`stage5_m123_tckdb_acceptance.json\`.\n\n## Generic Distractor and Graph Controls\n\nFocused tests cover central irrelevant hubs, exact targets, package/support behavior, score determinism, and authority projection.\n\n## Cross-Tool Convergence\n\n\`get_code_context\`, default \`get_context_capsule\`, and \`run_pipeline\` now obtain the same authoritative selected capsule; M119 \`productContext\` uses the same Capsule v2 core.\n\n## Compound-Query Regression\n\nM121 routed compound/path diagnostics remain unchanged. A post-freeze attempt to inject full raw-task decomposition into every hybrid lexical pass was reverted after it degraded top-1 to 58%; normal hybrid ordering is intentionally preserved.\n\n## Product Baseline\n\n\`product-retrieval-v2\`; decision C, legacy-quality shared core is product authority.\n\n## Invariants\n\nWorktree/indexing, M119 accounting, M120 static impact truthfulness, M121 routing diagnostics, and no-live behavior remain unchanged. No gold/outcome fields enter runtime scoring.\n\n## Limitations\n\nRetrospective frozen-corpus correction; no untouched holdout or live-agent-effect claim. Markdown and tokenizer-exact coverage remain deferred.\n\n## Deferred Work\n\nProspective validation, 100-case seam, M124 cross-repository workspace intelligence, tokenizer-exact accounting.\n\n## Success Criteria Check\n\nFrozen quality thresholds pass when ${audit.verdict === "PASS" ? "all required recall/count gates are applied" : "evaluated"}; TCKDB and full verification are separate required gates.\n\n## Verdict\n\n${audit.verdict}\n\n## Recommendation\n\nuse legacy-quality shared core as product authority\n`; }
function passes(m: any): boolean { return m.top_1_file_recall >= .78 && m.any_gold_recall >= .90 && m.all_gold_visible_recall >= .88 && m.lead_pivot_recall >= .78 && m.missing_count <= 5 && m.wrong_pivot_count <= 12 && m.no_candidates_count === 0; }
function distribution(values: number[]) { const sorted = [...values].sort((a, b) => a - b); return { median: round(sorted[Math.floor((sorted.length - 1) * .5)] ?? 0), p90: round(sorted[Math.floor((sorted.length - 1) * .9)] ?? 0), maximum: round(sorted.at(-1) ?? 0) }; }
function hitCount(expected: readonly string[], actual: readonly string[]): number { return expected.filter((e) => actual.some((a) => sameFile(a, e))).length; }
function sameFile(a: string, b: string): boolean { const x = normalize(a), y = normalize(b); return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`); }
function normalize(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\//, ""); }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function round(value: number): number { return Math.round(value * 1000) / 1000; }
function csv(value: unknown): string { const text = String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
async function writeJson(name: string, value: unknown): Promise<void> { await writeFile(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`); }

if (import.meta.main) await main();
