/**
 * M193A §18/§29/§31 — expected-vs-actual for everything that can be checked
 * without a model.
 *
 * Three jobs, deliberately in one place so a single command answers "did the
 * integrity closure change anything it should not have":
 *
 *   1. the synthetic lifecycle fixtures, classified by the frozen code
 *   2. the fake-agent dry run's source-version evidence, classified by the same
 *      code the live acquisition will use
 *   3. the three-way patch identity proof, re-run against the M193A ledger
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193a_analyze.ts
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  accountCorpus,
  assessAdequacy,
  classifyArmLifecycle,
  classifySourceVersion,
  comparePatchIdentity,
  normalizePatch,
  type ChangedFileFreshness,
  type SourceVersionState,
} from "./m193Acquisition";
import { FIXTURE_CORPUS_EXPECTATION, syntheticFixtures } from "./m193Fixtures";

const RESULTS = join(import.meta.dir, "results");
// M193B re-ran the frozen lifecycle against the repaired changed-source
// authority. `--ledger <name>` points the same analysis at that rerun without
// forking the analyser, so the two are compared by construction.
const LEDGER_ARG = process.argv.indexOf("--ledger");
const LEDGER_STEM = LEDGER_ARG > -1 ? (process.argv[LEDGER_ARG + 1] ?? "m193a") : "m193a";
const DRY_RUN = join(RESULTS, `stage5_${LEDGER_STEM}_dry_run_ledger.json`);
const OUT = join(RESULTS, `stage5_${LEDGER_STEM}_analysis.json`);

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ── 1. synthetic fixtures ────────────────────────────────────────────

const fixtureRows = syntheticFixtures().map((f) => {
  const l = classifyArmLifecycle(f.arm);
  const mismatches: string[] = [];
  const check = (name: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) mismatches.push(`${name}: expected ${String(expected)}, got ${String(actual)}`);
  };
  check("validity", l.validity, f.expect.validity);
  check("i6Usable", l.i6Usable, f.expect.i6Usable);
  check("i6UnusableReason", l.i6UnusableReason, f.expect.i6UnusableReason);
  check("runtimeDiagnosisUsable", l.runtimeDiagnosisUsable, f.expect.runtimeDiagnosisUsable);
  check("postEditValidationAttempts", l.postEditValidationAttempts, f.expect.postEditValidationAttempts);
  check("usableValidationEvents", l.usableValidationEvents, f.expect.usableValidationEvents);
  check("postValidationRevisions", l.postValidationRevisions, f.expect.postValidationRevisions);
  check("wrongSourceEvents", l.wrongSourceEvents, f.expect.wrongSourceEvents);
  check("sourceVersionAmbiguousEvents", l.sourceVersionAmbiguousEvents, f.expect.sourceVersionAmbiguousEvents);
  check("staleExecutionEvents", l.staleExecutionEvents, f.expect.staleExecutionEvents);
  return { id: f.id, description: f.description, mismatches, agrees: mismatches.length === 0 };
});
const fixtureAccounting = accountCorpus(syntheticFixtures().map((f) => classifyArmLifecycle(f.arm)), 0);

// ── 2. the dry run, through the live classifier ──────────────────────

interface SvEvidence {
  probeRan?: boolean;
  stateStableAcrossValidation?: boolean;
  changedSourceFileCount?: number;
  fileVerdicts?: ChangedFileFreshness[];
  files?: { path: string; verdict: string; reason?: string }[];
}

interface DryRunResult {
  instanceId: string;
  repo: string;
  verdict: string;
  errors?: string[];
  finalPatch?: string;
  phases: Record<string, Record<string, unknown>>;
}

const dry = JSON.parse(readFileSync(DRY_RUN, "utf8")) as {
  results: DryRunResult[];
  evaluator: { ran: boolean; perInstance?: Record<string, { evaluatorPatch?: string; resolved?: boolean }> };
};

function classifyDryRunValidation(ev: SvEvidence | null | undefined): SourceVersionState {
  if (!ev) return "UNKNOWN";
  return classifySourceVersion({
    isValidationAttempt: true,
    runnerStarted: true,
    probeRan: ev.probeRan === true,
    stateStableAcrossValidation: ev.stateStableAcrossValidation === true,
    changedSourceFileCount: ev.changedSourceFileCount ?? 0,
    fileVerdicts: ev.fileVerdicts ?? [],
  });
}

const dryRows = dry.results.map((r) => {
  const v1 = classifyDryRunValidation(r.phases.validation1?.sourceVersionEvidence as SvEvidence);
  const v2 = classifyDryRunValidation(r.phases.validation2?.sourceVersionEvidence as SvEvidence);
  const fals = (r.phases.sourceVersionFalsification ?? {}) as Record<string, Record<string, unknown>>;
  const stale = fals.staleCacheControl ?? {};
  const healthy = fals.healthyControl ?? {};
  const poison = fals.poisonedCopyControl ?? {};

  const evalEntry = dry.evaluator.perInstance?.[r.instanceId];
  const identity = comparePatchIdentity({
    interactiveFinalDiff: r.finalPatch ?? "",
    extractedPredictionPatch: r.finalPatch ?? "",
    evaluatorAppliedPatch: evalEntry?.evaluatorPatch ?? null,
  });

  return {
    instanceId: r.instanceId,
    repo: r.repo,
    lifecycleVerdict: r.verdict,
    validation1SourceVersion: v1,
    validation2SourceVersion: v2,
    // Why an event lost freshness, in the probe's own words. A count without
    // this is a number nobody can act on.
    unconfirmedFileReasons: [
      ...(((r.phases.validation1?.sourceVersionEvidence as SvEvidence)?.files ?? [])),
      ...(((r.phases.validation2?.sourceVersionEvidence as SvEvidence)?.files ?? [])),
    ]
      .filter((f) => f.verdict === "INDETERMINATE" || f.verdict === "CACHE_STALE_AND_ACCEPTED" || f.verdict === "COMPILED_ARTIFACT_REQUIRED")
      .map((f) => `${f.path}: ${f.verdict} — ${f.reason ?? ""}`),
    controls: {
      stale: {
        expected: "CACHE_STALE_AND_ACCEPTED",
        actual: stale.actualSourceVersion ?? null,
        staleExecutionObserved: stale.valueExecuted ?? null,
        agrees: stale.actualSourceVersion === "CACHE_STALE_AND_ACCEPTED",
      },
      healthy: {
        expectedIn: ["CACHE_MATCHES_CURRENT_SOURCE", "COMPILED_FROM_CURRENT_SOURCE"],
        actual: healthy.actualSourceVersion ?? null,
        agrees:
          healthy.actualSourceVersion === "CACHE_MATCHES_CURRENT_SOURCE" ||
          healthy.actualSourceVersion === "COMPILED_FROM_CURRENT_SOURCE",
      },
      poisonedCopy: {
        copied: poison.copied ?? false,
        moduleFileFromNeutralCwd: poison.moduleFileFromNeutralCwd ?? null,
        // The whole point: current bytes, wrong file. The path axis must refuse.
        agrees: poison.copied === true && poison.resolvesOutsideCheckout === true,
      },
    },
    patchIdentity: {
      verdict: identity.verdict,
      interactiveNormalizedSha256: sha256(normalizePatch(r.finalPatch ?? "")),
      evaluatorNormalizedSha256: evalEntry?.evaluatorPatch ? sha256(normalizePatch(evalEntry.evaluatorPatch)) : null,
      resolved: evalEntry?.resolved ?? null,
    },
  };
});

const gates = {
  G6_i6_requires_source_version: fixtureRows.every((r) => r.agrees),
  G11_dry_run_lifecycle: dry.results.every((r) => r.verdict === "DRY_RUN_LIFECYCLE_OK"),
  G12_patch_identity_strict: dryRows.every((r) => r.patchIdentity.verdict === "IDENTICAL_STRICT"),
  G13_existing_fixtures_unchanged: fixtureRows.filter((r) => /^F0[1-9]|^F1[0-2]/.test(r.id)).every((r) => r.agrees),
  stale_control_agrees: dryRows.every((r) => r.controls.stale.agrees),
  healthy_control_agrees: dryRows.every((r) => r.controls.healthy.agrees),
  poisoned_copy_control_agrees: dryRows.every((r) => r.controls.poisonedCopy.agrees),
  evaluator_resolved_all: dryRows.every((r) => r.patchIdentity.resolved === true),
};

const doc = {
  schemaVersion: "stage5.m193a.analysis.v1",
  milestone: "M193A",
  liveModelCalls: 0,
  liveModelSpendUsd: 0,
  fixtures: {
    count: fixtureRows.length,
    agreeing: fixtureRows.filter((r) => r.agrees).length,
    rows: fixtureRows,
    accounting: fixtureAccounting,
    adequacy: assessAdequacy(fixtureAccounting),
    frozenExpectation: FIXTURE_CORPUS_EXPECTATION,
    frozenExpectationHolds:
      fixtureAccounting.validRuns === FIXTURE_CORPUS_EXPECTATION.validRuns &&
      fixtureAccounting.i6UsableArms === FIXTURE_CORPUS_EXPECTATION.i6UsableArms &&
      fixtureAccounting.runtimeDiagnosisUsableArms === FIXTURE_CORPUS_EXPECTATION.runtimeDiagnosisUsableArms &&
      assessAdequacy(fixtureAccounting) === FIXTURE_CORPUS_EXPECTATION.adequacy,
  },
  dryRun: { count: dryRows.length, rows: dryRows },
  gates,
  allGatesPass: Object.values(gates).every(Boolean),
};

writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${OUT}`);
console.log(`fixtures agreeing: ${doc.fixtures.agreeing}/${doc.fixtures.count}  frozen corpus expectation holds: ${doc.fixtures.frozenExpectationHolds}`);
for (const r of dryRows) {
  console.log(
    `  ${r.instanceId.padEnd(30)} v1=${r.validation1SourceVersion.padEnd(30)} v2=${r.validation2SourceVersion.padEnd(30)} ${r.patchIdentity.verdict} resolved=${String(r.patchIdentity.resolved)}`,
  );
}
for (const [k, v] of Object.entries(gates)) console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);
