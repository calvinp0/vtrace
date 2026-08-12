import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { indexProject } from "../../src/indexer/indexProject";
import { buildUnresolvedProductContext } from "../../src/productContext/assembleProductContext";
import { runReliableContextRetrieval } from "../../src/runPipeline/runPipelineOrchestrator";
import { RunPipelinePresetIntent } from "../../src/runPipeline/types";
import {
  prepareRunnerOutput,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";

const FIXTURE = fileURLToPath(new URL("../../fixtures/m121_compound_retrieval_repo", import.meta.url));
// M141: reports go to an untracked run directory unless --out/--evidence
// asks otherwise, so validating the evidence can never overwrite it.
const RUNNER_NAME = "m122_product_retrieval_smoke";
if (process.argv.includes("--help")) {
  console.log(`run_stage5_m122_product_retrieval_smoke.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
  process.exit(0);
}
const RESULTS = (await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME })).dir;
const cases = [
  ["exact_identifier", "RecordReproducibilityAssessment"],
  ["filename", "public_assessments.py"],
  ["standalone_path", "services/public_assessments.py"],
  ["prose_containing_path", "Update services/public_assessments.py and its public projection"],
  ["slash_punctuation", "trace immutability/supersession across assessment projection"],
  ["url", "API route https://example.test/api/v1/assessments should expose public_ref"],
  ["stack_trace", 'File "/repo/app/services/public_assessments.py", line 42: public_ref failed'],
  ["long_compound_task", Array.from({ length: 96 }, (_, i) => i < 4 ? ["public_ref", "PublicRefMixin", "RecordReproducibilityAssessment", "public_assessments.py"][i]! : `concern${i}`).join(" ")],
  ["no_context", "!!!"],
] as const;

interface SmokeRow {
  id: string;
  query: string;
  resolved: boolean;
  reason: string | null;
  selectedFiles: string[];
  leadPivot: string | null;
  candidateFilesConsidered: number;
  variantCount: number;
  legacySelectedFiles?: string[];
}

const temp = await mkdtemp(path.join(os.tmpdir(), "vtrace-m122-smoke-"));
const repoRoot = path.join(temp, "repo");
const incrementalDb = openIndexerDatabase();
const fullDb = openIndexerDatabase();
try {
  await cp(FIXTURE, repoRoot, { recursive: true });
  const initial = await indexProject({ db: incrementalDb, repoRoot, refreshMode: "full" });
  const incremental = await indexProject({ db: incrementalDb, repoRoot, refreshMode: "incremental" });
  const full = await indexProject({ db: fullDb, repoRoot, refreshMode: "full" });
  const rows: SmokeRow[] = cases.map(([id, query]) => evaluate(id, query, incrementalDb, repoRoot));
  const canonical = evaluate("incremental-refresh_index", "assessment public_ref projection schema migration", incrementalDb, repoRoot);
  const rebuilt = evaluate("full-rebuild_index", "assessment public_ref projection schema migration", fullDb, repoRoot);
  rows.push(canonical, rebuilt);

  const legacy = buildCapsuleV2({ db: incrementalDb, repoRoot, task: "assessment public_ref projection schema migration", intent: CapsuleIntent.Modify, maxTokens: 8_000 });
  rows.push({
    id: "product-legacy_comparison",
    query: "assessment public_ref projection schema migration",
    resolved: canonical.resolved,
    reason: null,
    selectedFiles: canonical.selectedFiles,
    leadPivot: canonical.leadPivot,
    candidateFilesConsidered: canonical.candidateFilesConsidered,
    variantCount: canonical.variantCount,
    legacySelectedFiles: [...legacy.pivots, ...legacy.support].map((item) => item.path),
  });
  const stale = buildUnresolvedProductContext({
    task: "assessment public_ref",
    repoRoot: "<repo>", repositoryId: "fixture", worktreeId: "fixture", headCommit: null, branch: null, detached: false,
    freshnessStatus: "stale", freshnessReason: "smoke_fixture", freshnessAction: "index_repo", totalMs: 0, budgetTokens: 8_000,
  });
  rows.push({ id: "stale_index", query: stale.task, resolved: stale.resolved, reason: stale.freshness.reason, selectedFiles: stale.diagnostics.selectedFiles, leadPivot: stale.leadPivot, candidateFilesConsidered: 0, variantCount: 0 });

  const equivalent = JSON.stringify(canonical.selectedFiles) === JSON.stringify(rebuilt.selectedFiles) && canonical.leadPivot === rebuilt.leadPivot;
  const detail = {
    schemaVersion: "stage5.m122.product-retrieval-smoke.v1",
    index: {
      initial: { mode: initial.performance?.mode, files: initial.totalFilesSuccessfullyIndexed },
      incremental: { mode: incremental.performance?.mode, files: incremental.totalFilesSuccessfullyIndexed },
      full: { mode: full.performance?.mode, files: full.totalFilesSuccessfullyIndexed },
      incrementalFullRetrievalEquivalent: equivalent,
    },
    cases: rows,
    pass: rows.every((row) => row.id === "no_context" || row.id === "stale_index" || row.resolved) && equivalent,
  };
  await mkdir(RESULTS, { recursive: true });
  await writeFile(path.join(RESULTS, "stage5_m122_product_retrieval_smoke.detail.json"), `${JSON.stringify(detail, null, 2)}\n`);
  const header = "id,resolved,reason,lead_pivot,candidate_files_considered,variant_count,selected_files\n";
  const csv = rows.map((row) => [row.id, row.resolved, row.reason ?? "", row.leadPivot ?? "", row.candidateFilesConsidered, row.variantCount, row.selectedFiles.join("|")].map(escapeCsv).join(",")).join("\n");
  await writeFile(path.join(RESULTS, "stage5_m122_product_retrieval_smoke.csv"), `${header}${csv}\n`);
  process.stdout.write(`M122 smoke: ${detail.pass ? "PASS" : "FAIL"}; ${rows.length} cases\n`);
} finally {
  incrementalDb.close();
  fullDb.close();
  await rm(temp, { recursive: true, force: true });
}

function evaluate(id: string, query: string, db: ReturnType<typeof openIndexerDatabase>, repoRoot: string): SmokeRow {
  const context = runReliableContextRetrieval(db, repoRoot, { query, preset: RunPipelinePresetIntent.Modify, maxResults: 20, maxBudgetCharacters: 32_000 });
  const selected = [...context.capsule.pivots, ...context.capsule.supportingItems];
  return {
    id,
    query,
    resolved: selected.length > 0,
    reason: context.skipReason,
    selectedFiles: [...new Set(selected.map((item) => item.filePath))],
    leadPivot: context.capsule.pivots[0]?.filePath ?? null,
    candidateFilesConsidered: context.retrievalDiagnostics.candidateFilesConsidered,
    variantCount: context.retrievalDiagnostics.search.queryVariants.length,
  };
}

function escapeCsv(value: unknown): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
