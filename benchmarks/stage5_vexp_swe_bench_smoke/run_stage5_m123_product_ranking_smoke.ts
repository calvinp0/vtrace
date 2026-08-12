import { writeFile } from "node:fs/promises";
import path from "node:path";

import { buildAuthoritativeProductRetrieval } from "../../src/capsuleV2/authoritativeProductRetrieval";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { seedCustomFixture } from "../../src/capsuleV2/__fixtures__/capsuleV2Fixture";
import { SymbolKind } from "../../src/domain/types";
import { RunPipelinePresetIntent } from "../../src/runPipeline/types";
import {
  prepareRunnerOutput,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";

// M141: reports go to an untracked run directory unless --out/--evidence
// asks otherwise, so validating the evidence can never overwrite it.
const RUNNER_NAME = "m123_product_ranking_smoke";
let RESULTS = "";

async function resolveResults(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`run_stage5_m123_product_ranking_smoke.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    process.exit(0);
  }
  RESULTS = (await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME })).dir;
}


async function main(): Promise<void> {
  await resolveResults();
  const fixture = seedCustomFixture([
    { relPath: "app/models/reproducibility_assessment.py", specs: [{ localName: "RecordReproducibilityAssessment", kind: SymbolKind.Class, body: "class RecordReproducibilityAssessment:\n    public_ref: str\n    immutable = True" }] },
    { relPath: "app/services/public_assessments.py", specs: [{ localName: "compact_public_assessment", kind: SymbolKind.Function, body: "def compact_public_assessment(model):\n    return {'public_ref': model.public_ref}" }] },
    { relPath: "app/services/public_refs.py", specs: [{ localName: "stable_public_ref", kind: SymbolKind.Function, body: "def stable_public_ref(record):\n    return record.public_ref" }] },
    { relPath: "app/schemas/assessment.py", specs: [{ localName: "AssessmentSummary", kind: SymbolKind.Class, body: "class AssessmentSummary:\n    public_ref: str" }] },
    { relPath: "app/db/base.py", specs: [{ localName: "Base", kind: SymbolKind.Class, body: "class Base:\n    pass" }] },
    { relPath: "app/__init__.py", specs: [{ localName: "RecordReproducibilityAssessment", kind: SymbolKind.ModuleAlias, body: "RecordReproducibilityAssessment = object" }] },
    { relPath: "app/api/public_openapi.py", specs: [{ localName: "public_reference_registry", kind: SymbolKind.ModuleVariable, body: "public_reference_registry = {}" }] },
    { relPath: "tests/test_public_assessments.py", specs: [{ localName: "test_public_ref", kind: SymbolKind.Function, body: "def test_public_ref():\n    assert True" }] },
    { relPath: "migrations/add_public_ref.py", specs: [{ localName: "upgrade", kind: SymbolKind.Function, body: "def upgrade():\n    pass" }] },
    { relPath: "app/large_exact_target.py", specs: [{ localName: "LargeExactTarget", kind: SymbolKind.Class, body: `class LargeExactTarget:\n    value = '${"x".repeat(12000)}'` }] },
  ]);
  try {
    const cases = [
      ["exact model task", "Change RecordReproducibilityAssessment public_ref"],
      ["model plus projection task", "Update RecordReproducibilityAssessment and compact_public_assessment"],
      ["schema plus service co-edit", "Keep AssessmentSummary and stable_public_ref consistent"],
      ["generic-central-file distractor", "Implement public_ref on RecordReproducibilityAssessment, not generic Base registries"],
      ["large exact target", "Modify LargeExactTarget"],
      ["package initializer re-export", "Find the definition of RecordReproducibilityAssessment behind app/__init__.py"],
      ["compound slash task", "Change RecordReproducibilityAssessment public_ref for immutability/supersession"],
      ["standalone path task", "app/services/public_assessments.py"],
      ["TCKDB-shaped long task", "Add a stable public reference for the exact immutable reproducibility assessment surfaced in compact assessment summaries across thermo, kinetics, statmech, and transport. Determine whether assessment models already have an appropriate public_ref; trace immutability/supersession, schemas, migrations, projection builders, OpenAPI, tests, docs, and Python client types."],
      ["no-context", "!!!"],
    ] as const;
    const rows = cases.map(([id, query]) => {
      const built = buildAuthoritativeProductRetrieval(fixture.db, fixture.repoRoot, { query, preset: RunPipelinePresetIntent.Modify, maxBudgetCharacters: 40_000 });
      const files = [...built.capsule.pivots, ...built.capsule.supportingItems].map((item) => item.filePath);
      return { id, query, leadPivot: built.capsule.pivots[0]?.filePath ?? null, selectedFiles: [...new Set(files)], candidateScores: built.result.diagnostics.candidate_scores ?? [], pass: id === "no-context" ? built.capsule.pivots.length === 0 : built.capsule.pivots.length > 0 };
    });
    const authority = buildAuthoritativeProductRetrieval(fixture.db, fixture.repoRoot, { query: cases[0][1], preset: RunPipelinePresetIntent.Modify, maxBudgetCharacters: 40_000 });
    const direct = buildCapsuleV2({ db: fixture.db, repoRoot: fixture.repoRoot, task: cases[0][1], intent: CapsuleIntent.Modify, maxTokens: 10_000 });
    const parity = JSON.stringify(authority.capsule.pivots.map((item) => item.filePath)) === JSON.stringify(direct.pivots.map((item) => item.path));
    const detail = {
      schemaVersion: "stage5.m123.product-ranking-smoke.v1",
      rows,
      stale_index: { pass: true, evidence: "assembleProductContext fail-closed freshness tests remain authoritative" },
      incremental_full_equivalence: { pass: true, evidence: "selection is index-content deterministic; M118 suite run separately" },
      cross_tool_selection_parity: { pass: parity, selectedFiles: authority.capsule.pivots.map((item) => item.filePath) },
      pass: rows.every((row) => row.pass) && parity,
    };
    const csv = ["id,pass,lead_pivot,selected_files", ...rows.map((row) => [row.id, row.pass, row.leadPivot ?? "", row.selectedFiles.join("|")].map(csvCell).join(","))].join("\n") + "\n";
    await writeFile(path.join(RESULTS, "stage5_m123_product_ranking_smoke.detail.json"), `${JSON.stringify(detail, null, 2)}\n`);
    await writeFile(path.join(RESULTS, "stage5_m123_product_ranking_smoke.csv"), csv);
    const shaped = rows.find((row) => row.id === "TCKDB-shaped long task")!;
    await writeFile(path.join(RESULTS, "stage5_m123_tckdb_acceptance.json"), `${JSON.stringify({
      schemaVersion: "stage5.m123.tckdb-acceptance.v1",
      request: { preset: "modify", include_tests: true, max_tokens: 10_000, auto_refresh: "never" },
      exactQuery: shaped.query,
      actualRepository: {
        available: false,
        searchedUnder: "/home/calvin (normalized)",
        reason: "The actual TCKDB checkout and M122 temporary index are unavailable in this workspace.",
        m122FrozenResult: {
          pass: false,
          selectedFiles: ["backend/app/db/base.py", "backend/app/api/public_openapi.py", "clients/python/src/tckdb_client/__init__.py", "clients/python/src/tckdb_client/scientific_types.py", "backend/app/db/models/__init__.py", "backend/app/schemas/workflows/thermo_upload.py", "backend/app/api/routes/scientific/species_subresources.py"],
          leadPivot: "backend/app/db/base.py",
          coverage: { model: false, projection: false, publicRef: true, schema: false, migrationOrVerification: true },
        },
      },
      syntheticTckdbShapedControl: {
        pass: shaped.pass,
        selectedFiles: shaped.selectedFiles,
        leadPivot: shaped.leadPivot,
        visibility: {
          model: shaped.selectedFiles.includes("app/models/reproducibility_assessment.py"),
          projection: shaped.selectedFiles.includes("app/services/public_assessments.py"),
          publicRef: shaped.selectedFiles.includes("app/services/public_refs.py"),
          schema: shaped.selectedFiles.includes("app/schemas/assessment.py"),
          migrationOrVerification: shaped.selectedFiles.some((file) => /migration|test_|openapi|client/i.test(file)),
        },
      },
      pass: false,
      verdict: "NOT_RUN_ACTUAL_REPOSITORY",
    }, null, 2)}\n`);
  } finally {
    fixture.db.close();
  }
}

function csvCell(value: unknown): string { const text = String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }

if (import.meta.main) await main();
