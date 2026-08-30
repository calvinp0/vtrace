/**
 * M193A §35 — the fifteen readiness gates, evaluated against committed evidence.
 *
 * Every gate reads an artifact produced by a script that actually ran. None is
 * satisfied by a statement in this file. Where a gate needs a real container it
 * reads the container run's ledger; where it needs the classifier it reads the
 * classifier's own output.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193a_readiness.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { M193_ADEQUACY } from "./m193Acquisition";

const RESULTS = join(import.meta.dir, "results");
const read = (n: string) => JSON.parse(readFileSync(join(RESULTS, n), "utf8")) as Record<string, any>;

const repro = read("stage5_m193a_bytecode_reproduction.json");
const analysis = read("stage5_m193a_analysis.json");
const isolation = read("stage5_m193a_isolation_evidence.json");
const diff = read("stage5_m193a_manifest_diff.json");
const dry = read("stage5_m193a_dry_run_ledger.json");
const m193a = read("stage5_m193a_manifest.json");

interface Gate {
  id: string;
  question: string;
  evidence: string;
  detail: string;
  pass: boolean;
}

const reproResults = repro.results as Record<string, any>[];
const dryRows = analysis.dryRun.rows as Record<string, any>[];
const fixtureRows = analysis.fixtures.rows as Record<string, any>[];
const acc = analysis.fixtures.accounting as Record<string, number>;

const forcedStale = reproResults.filter((r) => r.forcedCollision?.staleExecutionObserved === true);
const forcedClassified = forcedStale.filter((r) => r.forcedCollision?.sourceVersionVerdict === "CACHE_STALE_AND_ACCEPTED");
const healthyOk = reproResults.filter(
  (r) =>
    r.healthyControl?.currentSourceObserved === true &&
    ["CACHE_MATCHES_CURRENT_SOURCE", "COMPILED_FROM_CURRENT_SOURCE"].includes(r.healthyControl?.sourceVersionVerdict),
);

const gates: Gate[] = [
  {
    id: "G1",
    question: "is M193's frozen task/model/budget design unchanged except for integrity fields?",
    evidence: "stage5_m193a_manifest_diff.json",
    detail: `${diff.leavesOutsideIntegrityScope.length} leaves outside the integrity scope; ${Object.values(diff.invariants).filter(Boolean).length}/${Object.keys(diff.invariants).length} invariants hold; old hash verified=${diff.oldManifestHashVerified}`,
    pass: diff.allInvariantsHold === true && diff.leavesOutsideIntegrityScope.length === 0,
  },
  {
    id: "G2",
    question: "was the stale-bytecode hazard reproduced mechanically rather than assumed?",
    evidence: "stage5_m193a_bytecode_reproduction.json",
    detail: `${forcedStale.length}/${reproResults.length} specimens executed stale code under a forced collision across CPython ${[...new Set(reproResults.map((r) => r.interpreter?.version))].filter(Boolean).sort().join(", ")}; natural (raced) hazard on ${repro.naturalHazardCount}/${reproResults.length}`,
    pass: forcedStale.length === reproResults.length && reproResults.length >= 5,
  },
  {
    id: "G3",
    question: "can a stale cache ever classify as the current source?",
    evidence: "stage5_m193a_bytecode_reproduction.json + stage5_m193a_dry_run_ledger.json",
    detail: `${forcedClassified.length}/${forcedStale.length} forced collisions classified CACHE_STALE_AND_ACCEPTED; ${dryRows.filter((r) => r.controls.stale.agrees).length}/${dryRows.length} in-container dry-run controls agree; 0 classified as current`,
    pass:
      forcedClassified.length === forcedStale.length &&
      dryRows.every((r) => r.controls.stale.agrees) &&
      !reproResults.some((r) => r.forcedCollision?.sourceVersionVerdict === "CACHE_MATCHES_CURRENT_SOURCE" && r.forcedCollision?.staleExecutionObserved),
  },
  {
    id: "G4",
    question: "can a healthy current-source state be positively confirmed?",
    evidence: "stage5_m193a_bytecode_reproduction.json + stage5_m193a_analysis.json",
    detail: `${healthyOk.length}/${reproResults.length} healthy controls confirmed; ${dryRows.filter((r) => r.controls.healthy.agrees).length}/${dryRows.length} in-container; ${dryRows.filter((r) => r.validation1SourceVersion === "CURRENT_EDITED_STATE_CONFIRMED").length}/${dryRows.length} natural first validations confirmed`,
    pass: healthyOk.length === reproResults.length && dryRows.every((r) => r.controls.healthy.agrees),
  },
  {
    id: "G5",
    question: "is the poisoned-copy wrong-source control still rejected?",
    evidence: "stage5_m193a_dry_run_ledger.json + F15",
    detail: `${dryRows.filter((r) => r.controls.poisonedCopy.agrees).length}/${dryRows.length} shadow installs resolved outside the checkout with current bytes carried forward; fixture F15 classifies I6-unusable on the path axis`,
    pass:
      dryRows.every((r) => r.controls.poisonedCopy.agrees) &&
      fixtureRows.some((r) => r.id === "F15_STALE_EXECUTION_WRONG_PATH" && r.agrees),
  },
  {
    id: "G6",
    question: "does I6 usability require current-source-version authority?",
    evidence: "stage5_m193a_analysis.json",
    detail: `${analysis.fixtures.agreeing}/${analysis.fixtures.count} fixtures classify as frozen; F13 and F16 are RUN_VALID and I6-unusable for I6_UNUSABLE_SOURCE_VERSION`,
    pass:
      analysis.gates.G6_i6_requires_source_version === true &&
      fixtureRows.some((r) => r.id === "F13_SOURCE_VERSION_AMBIGUOUS" && r.agrees) &&
      fixtureRows.some((r) => r.id === "F16_STALE_EXECUTION_CONFIRMED" && r.agrees),
  },
  {
    id: "G7",
    question: "does an ambiguous or stale validation stay visible in the accounting?",
    evidence: "stage5_m193a_analysis.json",
    detail: `sourceVersionAmbiguousEvents=${acc.sourceVersionAmbiguousEvents} staleExecutionEvents=${acc.staleExecutionEvents} validButI6UnusableSourceVersionArms=${acc.validButI6UnusableSourceVersionArms} while validRuns=${acc.validRuns}`,
    pass:
      acc.sourceVersionAmbiguousEvents > 0 &&
      acc.staleExecutionEvents > 0 &&
      acc.validButI6UnusableSourceVersionArms > 0 &&
      acc.validRuns === analysis.fixtures.frozenExpectation.validRuns,
  },
  {
    id: "G8",
    question: "is the private Claude configuration constructed automatically?",
    evidence: "stage5_m193a_isolation_evidence.json",
    detail: `freshly created=${isolation.constructedArm.configDirFreshlyCreated}, copied=${JSON.stringify(isolation.constructedArm.allowedFilesCopied)}, present=${JSON.stringify(isolation.constructedArm.filesPresentAtConstruction)}`,
    pass: isolation.gates.G8_private_config_constructed_automatically === true,
  },
  {
    id: "G9",
    question: "can a contaminated parent or default configuration leak into an arm?",
    evidence: "stage5_m193a_isolation_evidence.json + m193aArmEnvironment.test.ts",
    detail: `inherited=${isolation.inheritedConfiguration.mcpServerCount} servers, credentials-only=${isolation.credentialsOnlyConfiguration.mcpServerCount}, credentials-only+strict=${isolation.credentialsOnlyConfiguration.withStrictMcpConfig.mcpServerCount}, constructed arm=${isolation.constructedArm.mcpServerCount}`,
    pass: isolation.gates.G9_contaminated_parent_cannot_leak === true && isolation.constructedArm.mcpServerCount === 0,
  },
  {
    id: "G10",
    question: "does a treatment-isolation failure block the launch?",
    evidence: "stage5_m193a_isolation_evidence.json + m193aArmEnvironment.test.ts",
    detail: `mayLaunchModel tracks the audit exactly; reuse, absent credentials, a non-baseline settings file, a missing isolation settings file, a post-construction CLAUDE.md, a live MCP server and a dropped --strict-mcp-config each fail closed`,
    pass: isolation.gates.G10_isolation_failure_blocks_launch === true && isolation.preLaunchAudit.clean === isolation.constructedArm.mayLaunchModel,
  },
  {
    id: "G11",
    question: "does the fake-agent dry run still carry every repository container-to-evaluator?",
    evidence: "stage5_m193a_dry_run_ledger.json",
    detail: `${(dry.results as Record<string, any>[]).filter((r) => r.verdict === "DRY_RUN_LIFECYCLE_OK").length}/${dry.instanceCount} lifecycles OK; evaluator ran=${dry.evaluator.ran} rc=${dry.evaluator.returnCode}; ${dryRows.filter((r) => r.patchIdentity.resolved === true).length}/${dryRows.length} resolved`,
    pass: analysis.gates.G11_dry_run_lifecycle === true && dry.evaluator.ran === true,
  },
  {
    id: "G12",
    question: "is three-way patch identity still strict?",
    evidence: "stage5_m193a_analysis.json",
    detail: `${dryRows.filter((r) => r.patchIdentity.verdict === "IDENTICAL_STRICT").length}/${dryRows.length} IDENTICAL_STRICT`,
    pass: analysis.gates.G12_patch_identity_strict === true,
  },
  {
    id: "G13",
    question: "do the twelve pre-existing M193 lifecycle fixtures classify identically?",
    evidence: "stage5_m193a_analysis.json",
    detail: `${fixtureRows.filter((r) => /^F0[1-9]_|^F1[0-2]_/.test(r.id) && r.agrees).length}/12 unchanged; the four new fixtures are additions, not edits`,
    pass:
      analysis.gates.G13_existing_fixtures_unchanged === true &&
      fixtureRows.filter((r) => /^F0[1-9]_|^F1[0-2]_/.test(r.id)).length === 12,
  },
  {
    id: "G14",
    question: "is the corpus adequacy threshold unchanged?",
    evidence: "m193Acquisition.ts + stage5_m193a_manifest_diff.json",
    detail: `ADEQUATE ${M193_ADEQUACY.adequate.i6UsableArms}/${M193_ADEQUACY.adequate.repositoriesAmongI6Usable}/${M193_ADEQUACY.adequate.validRuns}, PARTIAL ${M193_ADEQUACY.partial.i6UsableArms}/${M193_ADEQUACY.partial.repositoriesAmongI6Usable}/${M193_ADEQUACY.partial.validRuns}`,
    pass: diff.invariants.adequacyUnchanged === true,
  },
  {
    id: "G15",
    question: "were there zero live model calls?",
    evidence: "every M193A artifact records its own spend",
    detail: `reproduction=${repro.liveModelCalls}, dry run=${dry.liveModelCalls}, analysis=${analysis.liveModelCalls}, isolation=${isolation.liveModelCalls}`,
    pass:
      repro.liveModelCalls === 0 &&
      dry.liveModelCalls === 0 &&
      analysis.liveModelCalls === 0 &&
      isolation.liveModelCalls === 0 &&
      repro.liveModelSpendUsd === 0 &&
      dry.liveModelSpendUsd === 0 &&
      isolation.liveModelSpendUsd === 0,
  },
];

const failed = gates.filter((g) => !g.pass);
const doc = {
  schemaVersion: "stage5.m193a.readiness.v1",
  milestone: "M193A",
  liveModelCalls: 0,
  liveModelSpendUsd: 0,
  gates,
  passed: gates.length - failed.length,
  total: gates.length,
  failedGateIds: failed.map((g) => g.id),
  manifestHash: m193a.manifestHash,
  derivedFromManifestHash: m193a.derivedFrom.manifestHash,
  verdict: failed.length === 0 ? "M194_ACQUISITION_INTEGRITY_READY" : "M194_ACQUISITION_INTEGRITY_NOT_READY",
  standingAuthorizations: [
    "NO_VTRACE_I6_PRODUCT_IMPLEMENTATION_AUTHORIZED",
    "NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED",
    "I5_REMAINS_CLOSED",
  ],
  note: "Readiness is not permission. M194 requires an explicit spend authorisation from the project owner.",
};

writeFileSync(join(RESULTS, "stage5_m193a_readiness.json"), `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${join(RESULTS, "stage5_m193a_readiness.json")}`);
for (const g of gates) console.log(`  ${g.pass ? "PASS" : "FAIL"}  ${g.id}  ${g.question}\n           ${g.detail}`);
console.log(`\n${doc.passed}/${doc.total} — ${doc.verdict}`);
