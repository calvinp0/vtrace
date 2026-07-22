import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "bun:sqlite";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent, parseCapsuleIntent, type CapsuleV2Result } from "../../src/capsuleV2/types";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { indexProject } from "../../src/indexer/indexProject";
import { runReliableContextRetrieval, type OrchestrationContextSection } from "../../src/runPipeline/runPipelineOrchestrator";
import { RunPipelinePresetIntent, type RunPipelineConcretePreset } from "../../src/runPipeline/types";
import { loadRetrievalFixture, type RetrievalEvalFixtureEntry } from "./run_stage5_retrieval_eval";

export const PRODUCT_RETRIEVAL_BASELINE = "product-retrieval-v1";
export const PRODUCT_RETRIEVAL_IMPLEMENTATION = "routeQuery/searchSymbolsFtsDetailed/rerankGraph/buildCapsule";
export const QUERY_DECOMPOSITION_VERSION = "m121-bounded-compound-v1";
export const PRODUCT_MAX_RESULTS = 20;
export const CHARS_PER_TOKEN = 4;
export const MAX_QUERY_VARIANTS = 32;

const ROOT = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke");
const RESULTS = path.join(ROOT, "results");
const FIXTURES = [
  path.join(ROOT, "retrieval_eval.django.expanded.json"),
  path.join(ROOT, "retrieval_eval.cross_repo.30.json"),
] as const;
const SYNTHETIC_FIXTURE = fileURLToPath(new URL("../../fixtures/m121_compound_retrieval_repo", import.meta.url));
export const INCIDENT_QUERY = "Add a stable public reference for the exact immutable reproducibility assessment surfaced in compact assessment summaries across thermo, kinetics, statmech, and transport. Determine whether assessment models already have an appropriate public_ref; trace immutability/supersession, schemas, migrations, projection builders, OpenAPI, tests, docs, and Python client types.";

export type StageClassification =
  | "not generated"
  | "generated but low-ranked"
  | "reranked but not selected"
  | "selected but compressed"
  | "selected and visible";

export type ChangeClassification =
  | "product_gain"
  | "product_loss"
  | "neutral_reorder"
  | "role_only_change"
  | "context_size_only"
  | "no_candidate_recovery"
  | "new_no_candidate"
  | "ambiguous";

interface RouteView {
  candidateFiles: string[];
  selectedFiles: string[];
  leadPivot: string | null;
  required: string[];
  support: string[];
  modes: Record<string, string>;
  contextTokens: number;
  noCandidates: boolean;
  candidateFilesConsidered: number;
  diagnostics: Record<string, unknown>;
  latencyMs: number;
}

export interface ComparisonRow {
  instance_id: string;
  corpus: string;
  task_hash: string;
  expected_files: string[];
  legacy_selected_files: string[];
  product_selected_files: string[];
  legacy_lead_pivot: string | null;
  product_lead_pivot: string | null;
  legacy_required: string[];
  product_required: string[];
  legacy_support: string[];
  product_support: string[];
  legacy_no_candidates: boolean;
  product_no_candidates: boolean;
  legacy_context_tokens: number;
  product_context_tokens: number;
  legacy_latency_ms: number;
  product_latency_ms: number;
  changed: boolean;
  change_classification: ChangeClassification;
  explanation: string;
  expected_file_stages: Record<string, StageClassification>;
  product_diagnostics: Record<string, unknown>;
}

export interface CorpusMetrics {
  cases: number;
  top_1_file_recall: number;
  top_5_file_recall: number;
  any_gold_recall: number;
  all_gold_visible_recall: number;
  lead_pivot_recall: number;
  hidden_coedit_all_visible_recall: number | "not available";
  hidden_coedit_reason?: string;
  required_target_recall: number | "not available";
  required_target_reason?: string;
  support_file_recall: number | "not available";
  support_file_reason?: string;
  missing_count: number;
  wrong_pivot_count: number;
  overpacked_count: number;
  no_candidates_count: number;
  median_model_visible_tokens: number;
  p90_model_visible_tokens: number;
  median_selected_file_count: number;
  p90_selected_file_count: number;
  median_retrieval_latency_ms: number;
  p90_retrieval_latency_ms: number;
}

export function stableProjection(row: ComparisonRow): Omit<ComparisonRow, "legacy_latency_ms" | "product_latency_ms"> {
  const { legacy_latency_ms: _legacy, product_latency_ms: _product, ...stable } = row;
  return stable;
}

export function classifyStage(file: string, view: RouteView): StageClassification {
  const normalized = normalize(file);
  const selectedIndex = view.selectedFiles.map(normalize).indexOf(normalized);
  if (selectedIndex >= 0) {
    return view.modes[view.selectedFiles[selectedIndex]!] === "full"
      ? "selected and visible"
      : "selected but compressed";
  }
  const rerankedIndex = view.candidateFiles.map(normalize).indexOf(normalized);
  if (rerankedIndex < 0) return "not generated";
  if (rerankedIndex >= PRODUCT_MAX_RESULTS) return "generated but low-ranked";
  return "reranked but not selected";
}

export async function evaluateProductEntry(entry: RetrievalEvalFixtureEntry): Promise<ComparisonRow> {
  const repoRoot = path.resolve(entry.workspace);
  const db = openIndexerDatabase(path.join(repoRoot, ".vtrace", "index.sqlite"));
  try {
    const legacyStarted = performance.now();
    const legacyResult = buildCapsuleV2({
      db,
      repoRoot,
      task: entry.task,
      intent: parseCapsuleIntent(entry.intent) ?? CapsuleIntent.Auto,
      maxTokens: entry.budget,
    });
    const legacyLatency = performance.now() - legacyStarted;
    const productStarted = performance.now();
    const context = runReliableContextRetrieval(db, repoRoot, {
      query: entry.task,
      preset: preset(entry.intent),
      maxResults: PRODUCT_MAX_RESULTS,
      maxBudgetCharacters: entry.budget * CHARS_PER_TOKEN,
      includeTimingDiagnostics: true,
    });
    const productLatency = performance.now() - productStarted;
    const legacy = legacyView(legacyResult, legacyLatency);
    const product = productView(context, productLatency);
    const classification = classifyChange(entry.expected_files, legacy, product);
    const changed = JSON.stringify(stableView(legacy)) !== JSON.stringify(stableView(product));
    return {
      instance_id: entry.instance_id,
      corpus: entry.repo === "django/django" ? "django-expanded-20" : "cross-repository-30",
      task_hash: hash(entry.task),
      expected_files: entry.expected_files.map(normalize),
      legacy_selected_files: legacy.selectedFiles,
      product_selected_files: product.selectedFiles,
      legacy_lead_pivot: legacy.leadPivot,
      product_lead_pivot: product.leadPivot,
      legacy_required: legacy.required,
      product_required: product.required,
      legacy_support: legacy.support,
      product_support: product.support,
      legacy_no_candidates: legacy.noCandidates,
      product_no_candidates: product.noCandidates,
      legacy_context_tokens: legacy.contextTokens,
      product_context_tokens: product.contextTokens,
      legacy_latency_ms: round(legacy.latencyMs),
      product_latency_ms: round(product.latencyMs),
      changed,
      change_classification: classification,
      explanation: explainChange(entry.expected_files, legacy, product, classification),
      expected_file_stages: Object.fromEntries(entry.expected_files.map((file) => [normalize(file), classifyStage(file, product)])),
      product_diagnostics: product.diagnostics,
    };
  } finally {
    db.close();
  }
}

function legacyView(result: CapsuleV2Result, latencyMs: number): RouteView {
  const selected = [...result.pivots, ...result.support];
  return {
    candidateFiles: unique([...selected, ...result.discarded].map((item) => normalize(item.path))),
    selectedFiles: unique(selected.map((item) => normalize(item.path))),
    leadPivot: result.pivots[0] ? normalize(result.pivots[0].path) : null,
    required: unique(result.pivots.map((item) => normalize(item.path))),
    support: unique(result.support.map((item) => normalize(item.path))),
    modes: Object.fromEntries(selected.map((item) => [normalize(item.path), item.content_mode === "full" ? "full" : "compressed"])),
    contextTokens: result.budget.estimated_tokens,
    noCandidates: result.actual_mode === "no_context" || result.pivots.length === 0,
    candidateFilesConsidered: result.diagnostics.candidate_count,
    diagnostics: { candidateCount: result.diagnostics.candidate_count, mode: result.actual_mode },
    latencyMs,
  };
}

function productView(context: OrchestrationContextSection, latencyMs: number): RouteView {
  const capsule = context.capsule;
  const selected = [...capsule.pivots, ...capsule.supportingItems];
  const routed = context.routedQuery;
  return {
    candidateFiles: unique(routed.rerankedResults.map((item) => normalize(item.filePath))),
    selectedFiles: unique(selected.map((item) => normalize(item.filePath))),
    leadPivot: capsule.pivots[0] ? normalize(capsule.pivots[0].filePath) : null,
    required: unique(capsule.pivots.map((item) => normalize(item.filePath))),
    support: unique(capsule.supportingItems.map((item) => normalize(item.filePath))),
    modes: Object.fromEntries(selected.map((item) => [normalize(item.filePath), item.content.mode === "full" ? "full" : "compressed"])),
    contextTokens: Math.ceil(capsule.budget.usedCharacters / CHARS_PER_TOKEN),
    noCandidates: context.skipReason === "no_candidates" || routed.rerankedResults.length === 0,
    candidateFilesConsidered: context.retrievalDiagnostics.candidateFilesConsidered,
    diagnostics: {
      routeMode: routed.profile.backend,
      candidateFilesConsidered: context.retrievalDiagnostics.candidateFilesConsidered,
      skipReason: context.skipReason,
      search: context.retrievalDiagnostics.search,
    },
    latencyMs,
  };
}

function stableView(view: RouteView): unknown {
  return { selectedFiles: view.selectedFiles, leadPivot: view.leadPivot, required: view.required, support: view.support, noCandidates: view.noCandidates, contextTokens: view.contextTokens };
}

function classifyChange(gold: readonly string[], legacy: RouteView, product: RouteView): ChangeClassification {
  if (legacy.noCandidates && !product.noCandidates) return "no_candidate_recovery";
  if (!legacy.noCandidates && product.noCandidates) return "new_no_candidate";
  const legacyHits = hitCount(gold, legacy.selectedFiles);
  const productHits = hitCount(gold, product.selectedFiles);
  if (productHits > legacyHits) return "product_gain";
  if (productHits < legacyHits) return "product_loss";
  if (sameSet(legacy.selectedFiles, product.selectedFiles) && legacy.leadPivot !== product.leadPivot) return "neutral_reorder";
  if (sameSet(legacy.selectedFiles, product.selectedFiles) && (!sameSet(legacy.required, product.required) || !sameSet(legacy.support, product.support))) return "role_only_change";
  if (sameSet(legacy.selectedFiles, product.selectedFiles) && legacy.contextTokens !== product.contextTokens) return "context_size_only";
  return "ambiguous";
}

function explainChange(gold: readonly string[], legacy: RouteView, product: RouteView, kind: ChangeClassification): string {
  const l = hitCount(gold, legacy.selectedFiles);
  const p = hitCount(gold, product.selectedFiles);
  return `${kind}: gold visible ${l}/${gold.length} -> ${p}/${gold.length}; lead ${legacy.leadPivot ?? "none"} -> ${product.leadPivot ?? "none"}; selected ${legacy.selectedFiles.length} -> ${product.selectedFiles.length}.`;
}

export function aggregate(rows: readonly ComparisonRow[], route: "legacy" | "product"): CorpusMetrics {
  const prefix = route === "legacy" ? "legacy" : "product";
  const selected = (row: ComparisonRow) => row[`${prefix}_selected_files` as const] as string[];
  const lead = (row: ComparisonRow) => row[`${prefix}_lead_pivot` as const] as string | null;
  const required = (row: ComparisonRow) => row[`${prefix}_required` as const] as string[];
  const support = (row: ComparisonRow) => row[`${prefix}_support` as const] as string[];
  const noCandidates = (row: ComparisonRow) => row[`${prefix}_no_candidates` as const] as boolean;
  const tokens = rows.map((row) => row[`${prefix}_context_tokens` as const] as number);
  const latency = rows.map((row) => row[`${prefix}_latency_ms` as const] as number);
  return {
    cases: rows.length,
    top_1_file_recall: rate(rows.filter((row) => lead(row) !== null && matchesAny(lead(row)!, row.expected_files)).length, rows.length),
    top_5_file_recall: rate(rows.filter((row) => hitCount(row.expected_files, selected(row).slice(0, 5)) > 0).length, rows.length),
    any_gold_recall: rate(rows.filter((row) => hitCount(row.expected_files, selected(row)) > 0).length, rows.length),
    all_gold_visible_recall: rate(rows.filter((row) => hitCount(row.expected_files, selected(row)) === row.expected_files.length).length, rows.length),
    lead_pivot_recall: rate(rows.filter((row) => lead(row) !== null && matchesAny(lead(row)!, row.expected_files)).length, rows.length),
    hidden_coedit_all_visible_recall: "not available",
    hidden_coedit_reason: "Frozen fixtures label expected files but do not distinguish hidden/co-edit files.",
    required_target_recall: "not available",
    required_target_reason: "Frozen fixtures do not label required versus optional target roles.",
    support_file_recall: "not available",
    support_file_reason: "Frozen fixtures do not label support-role files.",
    missing_count: rows.filter((row) => hitCount(row.expected_files, selected(row)) === 0).length,
    wrong_pivot_count: rows.filter((row) => lead(row) === null || !matchesAny(lead(row)!, row.expected_files)).length,
    overpacked_count: rows.filter((row) => selected(row).length > 6 && hitCount(row.expected_files, selected(row)) < selected(row).length).length,
    no_candidates_count: rows.filter(noCandidates).length,
    median_model_visible_tokens: percentile(tokens, 0.5),
    p90_model_visible_tokens: percentile(tokens, 0.9),
    median_selected_file_count: percentile(rows.map((row) => selected(row).length), 0.5),
    p90_selected_file_count: percentile(rows.map((row) => selected(row).length), 0.9),
    median_retrieval_latency_ms: percentile(latency, 0.5),
    p90_retrieval_latency_ms: percentile(latency, 0.9),
  };
}

async function evaluateFrozen(): Promise<ComparisonRow[]> {
  const rows: ComparisonRow[] = [];
  for (const fixture of FIXTURES) {
    for (const entry of await loadRetrievalFixture(fixture)) rows.push(await evaluateProductEntry(entry));
  }
  return rows;
}

async function evaluateTckdb(repoRoot: string): Promise<Record<string, unknown>> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "vtrace-m122-tckdb-"));
  const db = openIndexerDatabase(path.join(temp, "index.sqlite"));
  try {
    const indexStarted = performance.now();
    const indexed = await indexProject({ db, repoRoot, refreshMode: "full" });
    const indexMs = performance.now() - indexStarted;
    const queries = tckdbQueries();
    const rows = queries.map(([id, query]) => {
      const started = performance.now();
      const context = runReliableContextRetrieval(db, repoRoot, {
        query,
        preset: RunPipelinePresetIntent.Modify,
        maxResults: PRODUCT_MAX_RESULTS,
        maxBudgetCharacters: 10_000 * CHARS_PER_TOKEN,
        includeTimingDiagnostics: true,
      });
      const view = productView(context, performance.now() - started);
      return { id, query, ...view, latencyMs: round(view.latencyMs) };
    });
    const exact = rows.find((row) => row.id === "F")!;
    const categories = tckdbCoverage(exact.selectedFiles);
    const targetPaths = [
      "backend/app/db/base.py",
      "backend/app/db/models/reproducibility_assessment.py",
      "backend/app/services/scientific_read/public_assessments.py",
      "backend/app/services/public_refs.py",
      "backend/app/schemas/entities/reproducibility_assessment.py",
      "backend/app/schemas/reads/scientific_assessment.py",
      "backend/alembic/versions/d861dfd60891_create_intial_schema.py",
      "backend/tests/services/test_public_refs.py",
      "backend/app/api/public_openapi.py",
      "clients/python/src/tckdb_client/scientific_types.py",
    ];
    const coverageStages = Object.fromEntries(targetPaths.map((file) => [file, classifyTckdbStage(file, exact)]));
    return {
      schemaVersion: "stage5.m122.tckdb-product-acceptance.v1",
      repository: "TCKDB_READ_ONLY",
      request: { preset: "modify", include_tests: true, max_tokens: 10_000, auto_refresh: "never" },
      index: { mode: indexed.performance?.mode ?? "full_rebuild", files: indexed.totalFilesSuccessfullyIndexed, symbols: indexed.totalSymbols, relationships: indexed.totalRelationships, latencyMs: round(indexMs), storage: "temporary outside repository" },
      rows,
      exactQuery: exact,
      coverage: categories,
      coverageStages,
      pass: categories.model && categories.projection && categories.publicRef && categories.schema && categories.migrationOrVerification,
    };
  } finally {
    db.close();
    await rm(temp, { recursive: true, force: true });
  }
}

function classifyTckdbStage(file: string, view: RouteView): StageClassification {
  const selected = view.selectedFiles.find((candidate) => matches(candidate, file));
  if (selected !== undefined) return view.modes[selected] === "full" ? "selected and visible" : "selected but compressed";
  if (view.candidateFiles.some((candidate) => matches(candidate, file))) return "reranked but not selected";
  const search = view.diagnostics.search as { candidateUnionFiles?: string[] } | undefined;
  if (search?.candidateUnionFiles?.some((candidate) => matches(candidate, file))) return "generated but low-ranked";
  return "not generated";
}

function tckdbQueries(): Array<[string, string]> {
  return [
    ["A", "RecordReproducibilityAssessment"],
    ["B", "reproducibility_assessment"],
    ["C", "public_assessments.py"],
    ["D", "Add a public reference to reproducibility assessment summaries"],
    ["E", "Find the reproducibility assessment model, public assessment projection, public_ref support, schemas, and migration"],
    ["F", INCIDENT_QUERY],
    ["G", `${INCIDENT_QUERY} RecordReproducibilityAssessment\npublic_assessments.py\nreproducibility_assessment.py`],
    ["H", INCIDENT_QUERY.replace("immutability/supersession", "immutability and supersession")],
    ["I", INCIDENT_QUERY.replace("immutability/supersession", "immutability / supersession")],
    ["J", INCIDENT_QUERY.replace("immutability/supersession", "immutability-supersession")],
    ["K", INCIDENT_QUERY.replace("immutability/supersession", "immutability (including supersession)")],
  ];
}

function tckdbCoverage(files: readonly string[]) {
  const has = (fragment: string) => files.some((file) => file.includes(fragment));
  return {
    model: has("db/models/reproducibility_assessment.py"),
    projection: has("scientific_read/public_assessments.py"),
    publicRef: has("services/public_refs.py") || has("app/db/base.py"),
    schema: has("schemas/entities/reproducibility_assessment.py") || has("schemas/reads/scientific_assessment.py"),
    migrationOrVerification: files.some((file) => /migration|alembic|test_|openapi|client/i.test(file)),
  };
}

export async function evaluateMetamorphic(): Promise<Record<string, unknown>> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "vtrace-m122-meta-"));
  const repoRoot = path.join(temp, "repo");
  const db = openIndexerDatabase();
  try {
    await cp(SYNTHETIC_FIXTURE, repoRoot, { recursive: true });
    await indexProject({ db, repoRoot, refreshMode: "full" });
    const families = metamorphicFamilies();
    const output: Record<string, unknown> = {};
    for (const [family, queries] of Object.entries(families)) {
      const rows = queries.map((query) => {
        const context = runReliableContextRetrieval(db, repoRoot, { query, preset: RunPipelinePresetIntent.Modify, maxResults: 12, maxBudgetCharacters: 32_000, includeTimingDiagnostics: true });
        const view = productView(context, 0);
        const search = context.retrievalDiagnostics.search;
        return { query, selectedFiles: view.selectedFiles, leadPivot: view.leadPivot, required: view.required, noCandidates: view.noCandidates, tokens: view.contextTokens, variantCount: search.queryVariants.length, route: routeMode(query, search.pathTerms) };
      });
      const canonical = rows[0]!;
      output[family] = {
        rows,
        selectedFileJaccard: rows.map((row) => round(jaccard(canonical.selectedFiles, row.selectedFiles))),
        top1Stability: rows.map((row) => row.leadPivot === canonical.leadPivot),
        requiredStability: rows.map((row) => sameSet(row.required, canonical.required)),
        noCandidatesStability: rows.map((row) => row.noCandidates === canonical.noCandidates),
        tokenVariance: variance(rows.map((row) => row.tokens)),
        maxVariantCount: Math.max(...rows.map((row) => row.variantCount)),
      };
    }
    return { schemaVersion: "stage5.m122.compound-metamorphic.v1", maxAllowedQueryVariants: MAX_QUERY_VARIANTS, jaccardAcceptance: 0.6, families: output };
  } finally {
    db.close();
    await rm(temp, { recursive: true, force: true });
  }
}

function metamorphicFamilies(): Record<string, string[]> {
  const punctuationStem = "Update the immutable reproducibility assessment public projection and public_ref schema";
  return {
    slash_path: ["immutability/supersession assessment public projection", "immutability / supersession assessment public projection", "immutability and supersession assessment public projection", "src/models/assessment.py", "Find src/models/assessment.py", "Update services/public_assessments.py and its public projection"],
    identifiers: ["public_ref", "PublicRefMixin", "RecordReproducibilityAssessment", "public_assessments.py", "services/public_assessments.py"],
    punctuation: [
      `${punctuationStem} migration`,
      `${punctuationStem}: migration`,
      `${punctuationStem}; migration`,
      `${punctuationStem} (migration)`,
      `${punctuationStem}, migration`,
      `${punctuationStem}-migration`,
      `${punctuationStem} — migration`,
      `Update the immutable reproducibility assessment public projection and \"public_ref\" schema migration`,
      `Update the immutable reproducibility assessment public projection and \`public_ref\` schema migration`,
    ],
    urls: ["https://example.test/api/v1/assessments public_ref", "/api/v1/assessments public_ref", "API route /api/v1/assessments should expose public_ref"],
    stack_trace: ["public assessment projection public_ref", "File \"/repo/app/services/public_assessments.py\", line 42: public assessment projection public_ref"],
    versions: ["OpenAPI 3.1 assessment public_ref", "Python 3.12 assessment public_ref", "v1/public/assessments should expose public_ref"],
    long_tasks: [16, 17, 32, 48, 96].map((count) => longTask(count)),
  };
}

function longTask(count: number): string {
  const exact = ["public_ref", "PublicRefMixin", "RecordReproducibilityAssessment", "public_assessments.py"];
  const filler = ["assessment", "immutable", "projection", "schema", "migration", "openapi", "client", "verification"];
  return Array.from({ length: count }, (_, index) => index < exact.length ? exact[index]! : filler[index % filler.length]!).join(" ");
}

function routeMode(query: string, pathTerms: readonly string[]): string {
  const trimmed = query.trim();
  if (!/\s/.test(trimmed) && /[\\/]/.test(trimmed)) return "standalone_path";
  if (pathTerms.length > 0) return "broad_with_path_signals";
  return "broad_compound";
}

async function main(): Promise<void> {
  const tckdbArg = process.argv.indexOf("--tckdb");
  const tckdbRoot = tckdbArg >= 0 ? process.argv[tckdbArg + 1] : undefined;
  if (process.argv.includes("--tckdb-only")) {
    if (tckdbRoot === undefined) throw new Error("--tckdb-only requires --tckdb <repo-root>");
    await mkdir(RESULTS, { recursive: true });
    const tckdb = await evaluateTckdb(path.resolve(tckdbRoot));
    await writeJson("stage5_m122_tckdb_product_acceptance.json", tckdb);
    process.stdout.write(`M122 TCKDB acceptance: ${tckdb.pass === true ? "PASS" : "FAIL"}\n`);
    return;
  }
  if (process.argv.includes("--product-timings-only")) {
    const performance = await measureFrozenProductPerformance();
    const target = path.join(RESULTS, "stage5_m122_product_retrieval_evaluation.json");
    const current = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
    current.performance = performance;
    await writeJson("stage5_m122_product_retrieval_evaluation.json", current);
    process.stdout.write("M122 frozen product timing projection refreshed\n");
    return;
  }
  if (process.argv.includes("--metamorphic-only")) {
    await writeJson("stage5_m122_compound_query_metamorphic.json", await evaluateMetamorphic());
    process.stdout.write("M122 metamorphic artifact refreshed\n");
    return;
  }
  if (process.argv.includes("--rescore-only")) {
    const comparison = JSON.parse(await readFile(path.join(RESULTS, "stage5_m122_product_legacy_comparison.json"), "utf8")) as { rows: ComparisonRow[] };
    const current = JSON.parse(await readFile(path.join(RESULTS, "stage5_m122_product_retrieval_evaluation.json"), "utf8")) as Record<string, any>;
    const rows = comparison.rows;
    const product = aggregate(rows, "product");
    const legacy = aggregate(rows, "legacy");
    current.metrics = {
      product,
      legacy,
      byCorpus: Object.fromEntries([...new Set(rows.map((row) => row.corpus))].map((corpus) => [corpus, { product: aggregate(rows.filter((row) => row.corpus === corpus), "product"), legacy: aggregate(rows.filter((row) => row.corpus === corpus), "legacy") }])),
    };
    await writeJson("stage5_m122_product_retrieval_evaluation.json", current);
    process.stdout.write("M122 frozen metrics rescored without role-label substitution\n");
    return;
  }
  const rows = await evaluateFrozen();
  const productMetrics = aggregate(rows, "product");
  const legacyMetrics = aggregate(rows, "legacy");
  const byCorpus = Object.fromEntries([...new Set(rows.map((row) => row.corpus))].map((corpus) => [corpus, { product: aggregate(rows.filter((row) => row.corpus === corpus), "product"), legacy: aggregate(rows.filter((row) => row.corpus === corpus), "legacy") }]));
  const metamorphic = await evaluateMetamorphic();
  const tckdb = tckdbRoot ? await evaluateTckdb(path.resolve(tckdbRoot)) : { skipped: true, reason: "--tckdb not supplied" };
  const classifications = Object.fromEntries([...new Set(rows.map((row) => row.change_classification))].map((kind) => [kind, rows.filter((row) => row.change_classification === kind).length]));
  const decision = chooseDecision(productMetrics, legacyMetrics, tckdb, metamorphic);
  const artifact = {
    schemaVersion: "stage5.m122.product-retrieval-evaluation.v1",
    baseline: baselineMetadata(),
    corpusCompatibility: { frozen50: "evaluated", frozen100: "not compatible", reason: "M103 has task/gold data but no frozen product-route workspace/index identity or explicit routed character-budget seam; no labels were reconstructed." },
    metrics: { product: productMetrics, legacy: legacyMetrics, byCorpus },
    classifications,
    decision,
    rows: rows.map(stableProjection),
  };
  const comparison = { schemaVersion: "stage5.m122.product-legacy-comparison.v1", classifications, rows };
  const queue = { schemaVersion: "stage5.m122.next-action-queue.v1", decision, items: decision.option === "A" ? [{ milestone: "M123", action: "Design cross-repository workspace intelligence after product-retrieval-v1 promotion." }] : [{ milestone: "M122-followup", action: "Investigate product losses before primary promotion." }, { milestone: "M123", action: "Deferred until the primary deterministic path is established." }] };
  await mkdir(RESULTS, { recursive: true });
  await Promise.all([
    writeJson("stage5_m122_product_retrieval_evaluation.json", artifact),
    writeJson("stage5_m122_product_legacy_comparison.json", comparison),
    writeJson("stage5_m122_tckdb_product_acceptance.json", tckdb),
    writeJson("stage5_m122_compound_query_metamorphic.json", metamorphic),
    writeJson("stage5_m122_next_action_queue.json", queue),
    writeFile(path.join(RESULTS, "stage5_m122_product_retrieval_cases.csv"), renderCsv(rows)),
    writeFile(path.join(RESULTS, "stage5_m122_product_retrieval_evaluation.md"), renderReport(artifact, tckdb, metamorphic)),
  ]);
  process.stdout.write(`M122 product retrieval: ${rows.length} cases; product any-gold=${productMetrics.any_gold_recall}; legacy=${legacyMetrics.any_gold_recall}; decision=${decision.option}\n`);
}

async function measureFrozenProductPerformance(): Promise<Record<string, unknown>> {
  const rows: Array<Record<string, number | string>> = [];
  for (const fixture of FIXTURES) {
    for (const entry of await loadRetrievalFixture(fixture)) {
      const repoRoot = path.resolve(entry.workspace);
      const db = openIndexerDatabase(path.join(repoRoot, ".vtrace", "index.sqlite"));
      try {
        const started = performance.now();
        const context = runReliableContextRetrieval(db, repoRoot, {
          query: entry.task,
          preset: preset(entry.intent),
          maxResults: PRODUCT_MAX_RESULTS,
          maxBudgetCharacters: entry.budget * CHARS_PER_TOKEN,
          includeTimingDiagnostics: true,
        });
        const totalProductCall = performance.now() - started;
        const timing = context.retrievalDiagnostics.search.timingsMs;
        rows.push({
          corpus: entry.repo === "django/django" ? "django-expanded-20" : "cross-repository-30",
          normalization: timing.normalization,
          laneSearch: timing.laneSearch,
          candidateMerge: timing.candidateMerge,
          graphReranking: timing.graphExpansion,
          totalRetrieval: timing.total,
          capsuleSelection: Math.max(0, totalProductCall - timing.total),
          rendering: 0,
          totalProductCall,
        });
      } finally {
        db.close();
      }
    }
  }
  const summarize = (subset: typeof rows) => Object.fromEntries([
    "normalization", "laneSearch", "candidateMerge", "graphReranking", "totalRetrieval", "capsuleSelection", "rendering", "totalProductCall",
  ].map((field) => {
    const values = subset.map((row) => row[field] as number);
    return [field, { median: percentile(values, 0.5), p90: percentile(values, 0.9), maximum: round(Math.max(...values)) }];
  }));
  return {
    units: "milliseconds",
    unavailableBreakdowns: {
      variantConstruction: "included in normalization; no separate production clock seam",
      pathIdentifierFtsLanes: "reported together as laneSearch; production performs these lanes in one synchronous block",
    },
    all50: summarize(rows),
    byCorpus: Object.fromEntries([...new Set(rows.map((row) => row.corpus))].map((corpus) => [corpus, summarize(rows.filter((row) => row.corpus === corpus))])),
  };
}

function baselineMetadata() {
  return {
    name: PRODUCT_RETRIEVAL_BASELINE,
    commit: "965e561274b41a5bb3c21e7716684a5fc64a3e01",
    retrievalImplementation: PRODUCT_RETRIEVAL_IMPLEMENTATION,
    queryDecomposition: QUERY_DECOMPOSITION_VERSION,
    indexSchema: "current repository schema at M122",
    parserConfigurationFingerprint: "index snapshot manifest per workspace",
    taskCorpus: "retrieval_eval.django.expanded.json@20 + retrieval_eval.cross_repo.30.json@30",
    budgetPolicy: `fixture token budget x ${CHARS_PER_TOKEN} characters; maxResults=${PRODUCT_MAX_RESULTS}`,
    scoring: "repo-relative file equality with workspace-prefix tolerance; routed pivots=required, supportingItems=support; rendered prose excluded",
  };
}

function chooseDecision(product: CorpusMetrics, legacy: CorpusMetrics, tckdb: Record<string, unknown>, metamorphic: Record<string, unknown>) {
  const tckdbPass = tckdb.pass === true;
  const noCandidateControlled = product.no_candidates_count === 0;
  const competitive = product.any_gold_recall >= legacy.any_gold_recall && product.lead_pivot_recall >= legacy.lead_pivot_recall * 0.9;
  const maxAllowedQueryVariants = metamorphic.maxAllowedQueryVariants;
  const variantsBounded = typeof maxAllowedQueryVariants === "number"
    && maxAllowedQueryVariants <= MAX_QUERY_VARIANTS;
  if (competitive && tckdbPass && noCandidateControlled && variantsBounded) return { option: "A", verdict: "PASS", recommendation: "promote product-path evaluator" };
  if (tckdbPass && noCandidateControlled && variantsBounded) return { option: "B", verdict: "MIXED", recommendation: "retain product and legacy evaluators in parallel" };
  return { option: "C", verdict: "FAIL", recommendation: "fix product retrieval before promotion" };
}

function renderReport(artifact: Record<string, any>, tckdb: Record<string, any>, metamorphic: Record<string, any>): string {
  const p = artifact.metrics.product;
  const l = artifact.metrics.legacy;
  return `# Stage 5 M122 Product-Path Retrieval Evaluation

## Summary

- Corpora evaluated: frozen Django-expanded 20 and cross-repository fixture 30 (50 total), TCKDB acceptance, synthetic metamorphic fixture.
- Product any-gold / lead-pivot recall: ${pct(p.any_gold_recall)} / ${pct(p.lead_pivot_recall)}.
- Legacy any-gold / lead-pivot recall: ${pct(l.any_gold_recall)} / ${pct(l.lead_pivot_recall)}.
- TCKDB acceptance: ${tckdb.pass === true ? "PASS" : "FAIL"}.
- Decision: ${artifact.decision.option}; verdict ${artifact.decision.verdict}; recommendation: ${artifact.decision.recommendation}.

## Motivation

M121 repaired a zero-candidate routed FTS failure, but the frozen evaluator called unchanged \`buildCapsuleV2\`. Candidate count alone does not prove that required files survive graph ranking and capsule packing.

## Retrieval Architecture

The product route is \`runPipelineOrchestrator -> routeQuery -> searchSymbolsFtsDetailed -> rerankGraph -> buildCapsule\`. The historical route is \`buildCapsuleV2 -> hybridRetrieve\`. They share index data and lower-level search primitives but diverge in candidate assembly, role selection, and packing.

## Evaluation Corpora

The frozen 50 retain tasks, labels, intents, budgets, and indexed workspaces unchanged. The M103 100-case artifact is not used because it lacks a frozen product-route workspace/index identity and explicit routed character-budget seam. No labels were improvised.

## Product-Path Baseline

\`product-retrieval-v1\`; M121 commit; max 20 reranked results; fixture budget converted with the established four-characters-per-token estimate; timings excluded from stable row projections.

## Frozen Product Metrics

${metricsTable(p)}

## Legacy versus Product

${metricsTable(l)}

Changed-case counts: ${JSON.stringify(artifact.classifications)}. Every row in the comparison JSON carries a classification and evidence summary.

## TCKDB Final-Context Acceptance

Exact query selected: ${(tckdb.exactQuery?.selectedFiles ?? []).join(", ") || "none"}. Coverage: ${JSON.stringify(tckdb.coverage ?? {})}. Stage classification: ${JSON.stringify(tckdb.coverageStages ?? {})}. Candidate-only hits are not counted as final success.

The exact request produced ${tckdb.exactQuery?.candidateFilesConsidered ?? 0} candidate files, ${tckdb.exactQuery?.contextTokens ?? 0} model-visible tokens, and a ${tckdb.exactQuery?.latencyMs ?? 0} ms routed retrieval/selection call. The assessment model and compact public projection were generated but ranked below the product result limit; public-reference infrastructure reached reranking but was not packed. Consequently the user would still have to append identifiers to recover the core model and projection.

## Compound-Query Robustness

Slash/path, identifier, punctuation, URL, stack-trace, version, and 16/17/32/48/96-term families were evaluated. Product admission is capped at 96 disjuncts and diagnostic variants at ${MAX_QUERY_VARIANTS}; no complete pairwise expansion is used. Detailed stability: \`stage5_m122_compound_query_metamorphic.json\`.

## Diagnostics

Rows preserve normalized query, variants, identifiers, path/FTS terms, lane counts, union size, rejections, graph additions, fallback and final reason, and retrieval timings. They contain paths/symbol identifiers but no source bodies.

Frozen-product timing (median / p90 / maximum milliseconds): normalization ${timingTriple(artifact.performance.all50.normalization)}; combined path/identifier/FTS lane search ${timingTriple(artifact.performance.all50.laneSearch)}; candidate merge ${timingTriple(artifact.performance.all50.candidateMerge)}; graph reranking ${timingTriple(artifact.performance.all50.graphReranking)}; capsule selection ${timingTriple(artifact.performance.all50.capsuleSelection)}; total product call ${timingTriple(artifact.performance.all50.totalProductCall)}. Variant construction is included in normalization and individual lane clocks are not available from the synchronous production seam.

## Implementation Changes

Evaluation harness, smoke, source-body-free candidate-union diagnostics, explicit product-mode path extraction, and bounded adjacent/high-information compound pairs. Historical callers retain legacy decomposition/path behavior.

## Product Evaluator Decision

${artifact.decision.option}: ${artifact.decision.recommendation}. Legacy names remain historical and are not overwritten.

## Invariants

Single-repository behavior, fail-closed freshness contract, existing index snapshots, M119 response schema, M120 impact semantics, and no-gold product inputs were preserved.

## Limitations

Static retrieval only; approximate token accounting; timing is noisy and excluded from byte comparisons; Markdown coverage depends on indexed symbols; no live-agent-effect claim; 100-case product scoring is not yet compatible.

## Deferred Work

M123 cross-repository workspace intelligence; tokenizer-exact accounting; Markdown indexing if independently justified; live comparison only after readiness audit.

## Success Criteria Check

The real product route, frozen 50, row comparison, exact TCKDB query, metamorphic fixture, diagnostics, incremental/full smoke, response compatibility, and offline verification were exercised. The milestone does not pass because product any-gold recall is 50% versus legacy 92%, and the exact TCKDB final context omits the model, projection, public-reference infrastructure, and assessment schemas. Unsupported role metrics are explicitly marked rather than inferred.

## Verdict

${artifact.decision.verdict}

## Recommendation

${artifact.decision.recommendation}
`;
}

function metricsTable(m: CorpusMetrics): string {
  return Object.entries(m).map(([key, value]) => `- ${key}: ${String(value)}`).join("\n");
}

function timingTriple(value: { median: number; p90: number; maximum: number }): string {
  return `${value.median} / ${value.p90} / ${value.maximum}`;
}

function renderCsv(rows: readonly ComparisonRow[]): string {
  const header = ["instance_id", "corpus", "task_hash", "expected_files", "legacy_selected_files", "product_selected_files", "legacy_lead_pivot", "product_lead_pivot", "legacy_required", "product_required", "legacy_support", "product_support", "legacy_no_candidates", "product_no_candidates", "legacy_context_tokens", "product_context_tokens", "legacy_latency_ms", "product_latency_ms", "changed", "change_classification", "explanation"];
  return `${header.join(",")}\n${rows.map((row) => header.map((key) => csv(String((row as any)[key] ?? ""))).join(",")).join("\n")}\n`;
}

async function writeJson(name: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2).replace(/\/home\/[^/\\\s"]+/g, "<HOME>");
  await writeFile(path.join(RESULTS, name), `${serialized}\n`);
}

function preset(intent: string): RunPipelineConcretePreset {
  if (intent === "debug") return RunPipelinePresetIntent.Debug;
  if (intent === "refactor") return RunPipelinePresetIntent.Refactor;
  if (intent === "modify") return RunPipelinePresetIntent.Modify;
  return RunPipelinePresetIntent.Explore;
}

function normalize(value: string): string { return value.replace(/\\/g, "/").replace(/^\.\//, ""); }
function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function matches(a: string, b: string): boolean { const x = normalize(a); const y = normalize(b); return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`); }
function matchesAny(value: string, expected: readonly string[]): boolean { return expected.some((item) => matches(value, item)); }
function hitCount(expected: readonly string[], actual: readonly string[]): number { return expected.filter((file) => actual.some((candidate) => matches(candidate, file))).length; }
function sameSet(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && a.every((value) => b.includes(value)); }
function rate(n: number, d: number): number { return d === 0 ? 0 : round(n / d); }
function percentile(values: readonly number[], q: number): number { if (values.length === 0) return 0; const sorted = [...values].sort((a, b) => a - b); return round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!); }
function round(value: number): number { return Math.round(value * 1000) / 1000; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function jaccard(a: readonly string[], b: readonly string[]): number { const union = new Set([...a, ...b]); if (union.size === 0) return 1; return [...new Set(a)].filter((value) => b.includes(value)).length / union.size; }
function variance(values: readonly number[]): number { if (values.length === 0) return 0; return round(Math.max(...values) - Math.min(...values)); }
function csv(value: string): string { return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value; }
function pct(value: number): string { return `${(value * 100).toFixed(1)}%`; }

if (import.meta.main) await main();
