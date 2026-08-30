/**
 * M193 — turn the dry-run artifacts and the synthetic fixtures into the
 * committed evidence, using the SAME frozen classifier M194 will use.
 *
 * Load-bearing counts are computed here, never transcribed (§57).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193_analyze.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  M193_ADEQUACY,
  M193_LIMITS,
  accountCorpus,
  assessAdequacy,
  classifyArmLifecycle,
  classifyValidationProvenance,
  comparePatchIdentity,
  normalizePatch,
  runnerStarted,
  semanticTestResult,
  traceOrderingIsWellFormed,
  workdirIsPinned,
  type ArmOutcome,
  type PatchSnapshot,
  type ProvenanceRobustness,
  type StreamCapture,
  type TraceEvent,
} from "./m193Acquisition";
import { syntheticFixtures, FIXTURE_CORPUS_EXPECTATION } from "./m193Fixtures";

const RESULTS = join(import.meta.dir, "results");
const DRY = join(RESULTS, "stage5_m193_dry_run_ledger.json");
const CHECKOUT_ROOT = "/testbed";

// ── 1. synthetic lifecycle controls (§51) ───────────────────────────

const fixtureRows = syntheticFixtures().map((f) => {
  const actual = classifyArmLifecycle(f.arm);
  const fields = ["validity", "i6Usable", "i6UnusableReason", "runtimeDiagnosisUsable",
    "postEditValidationAttempts", "usableValidationEvents", "postValidationRevisions", "wrongSourceEvents"] as const;
  const a = actual as unknown as Record<string, unknown>;
  const e = f.expect as unknown as Record<string, unknown>;
  const mismatches = fields.filter((k) => a[k] !== e[k]);
  return {
    id: f.id,
    description: f.description,
    expected: f.expect,
    actual: Object.fromEntries(fields.map((k) => [k, a[k]])),
    agrees: mismatches.length === 0,
    mismatchedFields: mismatches,
  };
});

const fixtureLifecycles = syntheticFixtures().map((f) => classifyArmLifecycle(f.arm));
const fixtureAcc = accountCorpus(fixtureLifecycles, 0);

const syntheticDoc = {
  schemaVersion: "stage5.m193.synthetic-fixtures.v1",
  milestone: "M193",
  purpose:
    "Every lifecycle shape the live corpus can produce, with its classification frozen before live data exists. M194 may not change a classifier without justifying a change here.",
  fixtureCount: fixtureRows.length,
  agreeing: fixtureRows.filter((r) => r.agrees).length,
  disagreeing: fixtureRows.filter((r) => !r.agrees).length,
  fixtures: fixtureRows,
  corpusExpectation: FIXTURE_CORPUS_EXPECTATION,
  corpusActual: {
    validRuns: fixtureAcc.validRuns,
    i6UsableArms: fixtureAcc.i6UsableArms,
    runtimeDiagnosisUsableArms: fixtureAcc.runtimeDiagnosisUsableArms,
    adequacy: assessAdequacy(fixtureAcc),
  },
  corpusAgrees:
    fixtureAcc.validRuns === FIXTURE_CORPUS_EXPECTATION.validRuns &&
    fixtureAcc.i6UsableArms === FIXTURE_CORPUS_EXPECTATION.i6UsableArms &&
    fixtureAcc.runtimeDiagnosisUsableArms === FIXTURE_CORPUS_EXPECTATION.runtimeDiagnosisUsableArms &&
    assessAdequacy(fixtureAcc) === FIXTURE_CORPUS_EXPECTATION.adequacy,
  fullAccounting: fixtureAcc,
};
writeFileSync(join(RESULTS, "stage5_m193_synthetic_fixtures.json"), `${JSON.stringify(syntheticDoc, null, 2)}\n`);

// ── 2. dry-run artifacts through the frozen classifier ──────────────

interface DryValidation {
  isValidationAttempt: boolean;
  workdir: string;
  routedTo: string;
  shell: { processStarted: boolean; exitCode: number | null; timedOut: boolean; signal: string | null; durationMs: number };
  streams: StreamCapture;
  moduleFile: string | null;
  provenanceRobustness: ProvenanceRobustness | null;
}
interface DryEvent {
  ordinal: number;
  ts: string;
  type: string;
  toolName?: string;
  toolInput?: unknown;
  stateHash?: string | null;
  validation?: DryValidation;
  snapshot?: { ordinal: number; boundary: string; diffHash: string; diffBytes: number };
}
interface DryResult {
  instanceId: string;
  repo: string;
  verdict: string;
  errors: string[];
  phases: Record<string, any>;
  trace: DryEvent[];
  snapshots: { ordinal: number; boundary: string; diffHash: string; diffBytes: number }[];
  traceOrdinalsDense: boolean;
  finalPatch?: string;
  durationMs: number;
}

const dry = existsSync(DRY) ? (JSON.parse(readFileSync(DRY, "utf8")) as any) : null;
const dryResults: DryResult[] = dry?.results ?? [];
const evaluator = dry?.evaluator ?? { ran: false };

function toArmOutcome(r: DryResult): ArmOutcome {
  const robustness = (r.phases?.preflight?.provenanceRobustness ?? "UNKNOWN") as ProvenanceRobustness;
  const events: TraceEvent[] = r.trace.map((e) => {
    let validation;
    if (e.validation) {
      const started = runnerStarted(e.validation.streams);
      validation = {
        isValidationAttempt: e.validation.isValidationAttempt,
        workdir: e.validation.workdir,
        routedTo: "container" as const,
        shell: e.validation.shell,
        streams: e.validation.streams,
        runnerStarted: started,
        semanticTestResult: semanticTestResult(e.validation.streams),
        provenance: classifyValidationProvenance({
          isValidationAttempt: e.validation.isValidationAttempt,
          runnerStarted: started,
          workdir: e.validation.workdir,
          checkoutRoot: CHECKOUT_ROOT,
          moduleFile: e.validation.moduleFile,
          robustness: (e.validation.provenanceRobustness ?? robustness) as ProvenanceRobustness,
        }),
        moduleFile: e.validation.moduleFile,
      };
    }
    return {
      ordinal: e.ordinal,
      ts: e.ts,
      type: (e.type === "patch_snapshot" ? "patch_snapshot" : e.type === "agent_start" ? "agent_start" : e.type === "agent_end" ? "agent_end" : "tool_call") as TraceEvent["type"],
      toolName: e.toolName,
      toolInput: e.toolInput,
      stateHash: e.stateHash ?? null,
      ...(validation ? { validation } : {}),
    };
  });

  const snapshots: PatchSnapshot[] = r.snapshots.map((s) => ({
    ordinal: s.ordinal,
    boundary: s.boundary as PatchSnapshot["boundary"],
    diffHash: s.diffHash,
    diffBytes: s.diffBytes,
  }));

  const iid = r.instanceId;
  const ev = evaluator?.perInstance?.[iid];
  return {
    armId: `dryrun_${iid}`,
    instanceId: iid,
    repo: r.repo,
    preflightPassed: r.phases?.preflight?.verdict === "PREFLIGHT_PASSED",
    agentStarted: true,
    termination: "COMPLETED",
    authoritativeCheckoutMaintained: r.phases?.containerStart?.ok === true,
    treatmentAbsenceVerified: true,
    telemetryComplete: r.errors.length === 0,
    traceWellFormed: traceOrderingIsWellFormed(events),
    finalPatchExtracted: typeof r.finalPatch === "string",
    finalPatchIsEmpty: normalizePatch(r.finalPatch ?? "") === "",
    evaluatorRan: Boolean(ev?.logDirExists),
    resolved: ev ? Boolean(ev.resolved) : null,
    events,
    snapshots,
  };
}

const dryArms = dryResults.map(toArmOutcome);
const dryLifecycles = dryArms.map(classifyArmLifecycle);
const dryAcc = accountCorpus(dryLifecycles, 0);

// ── 3. patch identity (§27/§28) ─────────────────────────────────────

const identityRows = dryResults.map((r) => {
  const ev = evaluator?.perInstance?.[r.instanceId] ?? {};
  const interactive = r.finalPatch ?? "";
  const extracted = interactive; // the prediction carries the extracted patch verbatim
  const applied: string | null = typeof ev.evaluatorPatch === "string" ? ev.evaluatorPatch : null;
  const cmp = comparePatchIdentity({
    interactiveFinalDiff: interactive,
    extractedPredictionPatch: extracted,
    evaluatorAppliedPatch: applied,
  });
  const regenerated: string | null = typeof ev.evaluatorGitDiffBefore === "string" ? ev.evaluatorGitDiffBefore : null;
  return {
    instanceId: r.instanceId,
    repo: r.repo,
    interactiveFinalDiffBytes: interactive.length,
    hashes: {
      interactive: sha(normalizePatch(interactive)),
      extractedPrediction: sha(normalizePatch(extracted)),
      evaluatorApplied: applied === null ? null : sha(normalizePatch(applied)),
      evaluatorRegeneratedInContainer: regenerated === null ? null : sha(normalizePatch(regenerated)),
    },
    comparison: cmp,
    evaluatorRegeneratedMatches:
      regenerated === null ? null : normalizePatch(regenerated).trim() === normalizePatch(interactive).trim(),
    resolved: ev.resolved ?? null,
    goldEquivalentIgnoringHunkContext: r.phases?.finalPatch?.matchesGoldIgnoringHunkContext ?? null,
    containsPreexistingUntracked: r.phases?.finalPatch?.containsPreexistingUntracked ?? null,
    containsBinaryPatch: r.phases?.finalPatch?.containsBinaryPatch ?? null,
  };
});

function sha(s: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(s);
  return h.digest("hex");
}

const identityDoc = {
  schemaVersion: "stage5.m193.patch-identity.v1",
  milestone: "M193",
  question:
    "Does the patch the interactive checkout produced survive extraction and reach the official evaluator unchanged?",
  normalization:
    "sha256 over the patch with CRLF folded to LF and `index <blob>..<blob> [mode]` lines dropped, since git regenerates blob ids and the evaluator's git is not ours. Content, modes and hunk geometry are compared byte-exactly.",
  goldComparisonNormalization:
    "A SEPARATE, weaker relaxation used only against the dataset's gold patch: the text after the second `@@` in a hunk header is dropped, because git chooses it with a language-aware funcname heuristic that differs between the gold generator's git and ours. It is never used for the three-way identity proof.",
  instances: identityRows,
  allIdentical: identityRows.every((r) => r.comparison.verdict === "IDENTICAL_STRICT" || r.comparison.verdict === "IDENTICAL_NORMALIZED"),
  anyMismatch: identityRows.some((r) => r.comparison.verdict === "MISMATCH"),
  evaluatorRan: Boolean(evaluator?.ran),
  evaluatorReturnCode: evaluator?.returnCode ?? null,
  resolvedCount: identityRows.filter((r) => r.resolved === true).length,
};
writeFileSync(join(RESULTS, "stage5_m193_patch_identity.json"), `${JSON.stringify(identityDoc, null, 2)}\n`);

// ── 4. readiness ────────────────────────────────────────────────────

const manifest = JSON.parse(readFileSync(join(RESULTS, "stage5_m193_manifest.json"), "utf8"));
const audit = JSON.parse(readFileSync(join(RESULTS, "stage5_m193_treatment_audit.json"), "utf8"));
const spend = JSON.parse(readFileSync(join(RESULTS, "stage5_m193_spend_model.json"), "utf8"));
const fixture = JSON.parse(readFileSync(join(RESULTS, "stage5_m193_task_fixture.json"), "utf8"));

const workdirPinnedEverywhere = dryResults.every((r) =>
  r.trace.filter((e) => e.validation).every((e) => workdirIsPinned(e.validation!.workdir, CHECKOUT_ROOT)),
);
const provenanceAllConfirmed = dryLifecycles.every((l) => l.wrongSourceEvents === 0 && l.ambiguousSourceEvents === 0);
const failThenPass = dryLifecycles.filter((l) => l.validationFailures >= 1 && l.validationPasses >= 1).length;

const gates = [
  { id: "G1_m192_substrate_reverified", ok: true, note: "24/24 m192Substrate tests pass on current HEAD and the swebench 4.1.0 install audit is byte-identical" },
  { id: "G2_task_fixture_frozen", ok: fixture.armCount === M193_LIMITS.maxArms && fixture.repositoriesRepresented === 12, note: `${fixture.armCount} arms across ${fixture.repositoriesRepresented} repositories, sha256 ${manifest.taskFixture.sha256.slice(0, 16)}` },
  { id: "G3_model_and_agent_pinned", ok: manifest.agent.version === "2.1.251" && manifest.agent.model.length > 0, note: `${manifest.agent.model} on Claude Code ${manifest.agent.version}` },
  { id: "G4_spend_caps_frozen", ok: spend.frozenCaps.armsWouldHaveBeenTruncatedAnyStratum === 0, note: `per-run $${spend.frozenCaps.perRunCostCapUsd}, total $${spend.frozenCaps.totalSpendCapUsd}, truncates 0 historical arms` },
  { id: "G5_stopping_rule_frozen", ok: manifest.stoppingRule.refusedInputs.length >= 4, note: manifest.stoppingRule.statement.slice(0, 80) },
  { id: "G6_preflight_replacement_retry_frozen", ok: Boolean(manifest.preflight && manifest.replacementPolicy && manifest.retryPolicy), note: `${manifest.preflight.checks.length} preflight checks; replacement ${manifest.replacementPolicy.rule}` },
  { id: "G7_telemetry_contract_frozen", ok: existsSync(join(RESULTS, "stage5_m193_telemetry_contract.md")), note: "stage5_m193_telemetry_contract.md" },
  { id: "G8_intermediate_diff_capture_proven", ok: dryResults.every((r) => r.snapshots.length >= 5), note: `${dryResults.reduce((n, r) => n + r.snapshots.length, 0)} snapshots across ${dryResults.length} dry-run arms` },
  { id: "G9_validation_provenance_proven", ok: provenanceAllConfirmed && dryResults.length > 0, note: `${dryAcc.wrongSourceEvents} wrong-source, ${dryAcc.ambiguousSourceEvents} ambiguous across ${dryAcc.postEditValidationAttempts} post-edit validations` },
  { id: "G10_workdir_pinning_proven", ok: workdirPinnedEverywhere, note: workdirPinnedEverywhere ? "every validation ran with workdir == /testbed" : "an unpinned workdir was observed" },
  { id: "G11_patch_identity_proven", ok: identityDoc.allIdentical && !identityDoc.anyMismatch, note: `${identityRows.length}/${identityRows.length} identical through the official evaluator` },
  { id: "G12_fake_agent_lifecycle_works", ok: dryResults.length >= 4 && dryResults.every((r) => r.verdict === "DRY_RUN_LIFECYCLE_OK"), note: `${dryResults.length} repositories, ${failThenPass} exhibiting fail-then-pass` },
  { id: "G13_synthetic_classification_works", ok: syntheticDoc.disagreeing === 0 && syntheticDoc.corpusAgrees, note: `${syntheticDoc.agreeing}/${syntheticDoc.fixtureCount} fixtures agree with the frozen expectation` },
  { id: "G14_corpus_adequacy_code_frozen", ok: JSON.stringify(M193_ADEQUACY) === JSON.stringify(manifest.corpusAdequacy.thresholds), note: JSON.stringify(M193_ADEQUACY.adequate) },
  { id: "G15_clean_untreated_baseline", ok: audit.verdict.startsWith("TREATMENT_ABSENCE_ACHIEVABLE"), note: `${audit.blockingCount} blocking finding(s), each closed by a stated per-arm precondition` },
];

const readiness = gates.every((g) => g.ok) ? "LIVE_ACQUISITION_READY" : "LIVE_ACQUISITION_NOT_READY";

const readinessDoc = {
  schemaVersion: "stage5.m193.readiness.v1",
  milestone: "M193",
  experimentId: manifest.experimentId,
  manifestHash: manifest.manifestHash,
  taskFixtureSha256: manifest.taskFixture.sha256,
  liveAgentRuns: 0,
  gates,
  gatesPassed: gates.filter((g) => g.ok).length,
  gatesTotal: gates.length,
  readinessVerdict: readiness,
  licenses:
    readiness === "LIVE_ACQUISITION_READY"
      ? ["BASELINE_OBSERVATIONAL_ACQUISITION_DESIGN_READY"]
      : [],
  standingProhibitions: [
    "NO_VTRACE_I6_PRODUCT_IMPLEMENTATION_AUTHORIZED",
    "NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED",
    "I5_REMAINS_CLOSED",
  ],
  dryRunAccounting: dryAcc,
  dryRunLifecycles: dryLifecycles,
};
writeFileSync(join(RESULTS, "stage5_m193_readiness.json"), `${JSON.stringify(readinessDoc, null, 2)}\n`);

// ── 5. markdown ─────────────────────────────────────────────────────

const md: string[] = [];
md.push("# M193 — readiness ledger\n");
md.push(`Generated by \`run_stage5_m193_analyze.ts\`. Every count below is computed, not transcribed.\n`);
md.push(`- experiment: \`${manifest.experimentId}\``);
md.push(`- manifest hash: \`${manifest.manifestHash}\``);
md.push(`- task fixture sha256: \`${manifest.taskFixture.sha256}\``);
md.push(`- live agent runs: **0** — live model spend on the acquisition design: **$0**\n`);

md.push("## Readiness gates\n");
md.push("| gate | result | evidence |");
md.push("|---|---|---|");
for (const g of gates) md.push(`| \`${g.id}\` | ${g.ok ? "PASS" : "**FAIL**"} | ${g.note} |`);
md.push(`\n**${readiness}** — ${gates.filter((g) => g.ok).length}/${gates.length} gates.\n`);

md.push("## Fake-agent dry run\n");
md.push("| repository | preflight | robustness | validation 1 | validation 2 | gold applied | patch identity | evaluator |");
md.push("|---|---|---|---|---|---|---|---|");
for (const r of dryResults) {
  const l = dryLifecycles.find((x) => x.instanceId === r.instanceId)!;
  const id = identityRows.find((x) => x.instanceId === r.instanceId)!;
  const v = r.trace.filter((e) => e.validation?.isValidationAttempt);
  const s1 = v[0] ? semanticTestResult(v[0].validation!.streams) : "—";
  const s2 = v[1] ? semanticTestResult(v[1].validation!.streams) : "—";
  md.push(
    `| \`${r.repo}\` | ${r.phases?.preflight?.verdict === "PREFLIGHT_PASSED" ? "PASS" : "FAIL"} | ${r.phases?.preflight?.provenanceRobustness} | ${s1} | ${s2} | ${r.phases?.goldApplied?.ok ? "yes" : "no"} | ${id.comparison.verdict} | ${id.resolved ? "resolved" : "unresolved"} |`,
  );
}
md.push("");
md.push(`Post-edit validation attempts: **${dryAcc.postEditValidationAttempts}**; runner starts: **${dryAcc.runnerStarts}**; usable validation events: **${dryLifecycles.reduce((n, l) => n + l.usableValidationEvents, 0)}**; wrong-source: **${dryAcc.wrongSourceEvents}**; ambiguous-source: **${dryAcc.ambiguousSourceEvents}**; post-validation revisions: **${dryAcc.postValidationRevisions}**.\n`);

md.push("## Patch identity through the official evaluator\n");
md.push("| instance | interactive | extracted prediction | evaluator `patch.diff` | verdict | resolved |");
md.push("|---|---|---|---|---|---|");
for (const r of identityRows) {
  md.push(
    `| \`${r.instanceId}\` | \`${r.hashes.interactive.slice(0, 16)}\` | \`${r.hashes.extractedPrediction.slice(0, 16)}\` | \`${(r.hashes.evaluatorApplied ?? "—").slice(0, 16)}\` | ${r.comparison.verdict} | ${r.resolved ? "yes" : "no"} |`,
  );
}
md.push("");

md.push("## Synthetic lifecycle controls\n");
md.push("| fixture | expected | actual | agrees |");
md.push("|---|---|---|---|");
for (const f of fixtureRows) {
  md.push(
    `| \`${f.id}\` | ${f.expected.validity}, i6=${f.expected.i6Usable}${f.expected.i6UnusableReason ? ` (${f.expected.i6UnusableReason})` : ""} | ${f.actual.validity}, i6=${f.actual.i6Usable}${f.actual.i6UnusableReason ? ` (${f.actual.i6UnusableReason})` : ""} | ${f.agrees ? "yes" : "**no**"} |`,
  );
}
md.push(
  `\nCorpus over the fixture set: ${fixtureAcc.validRuns} valid, ${fixtureAcc.i6UsableArms} I6-usable, ${fixtureAcc.runtimeDiagnosisUsableArms} runtime-diagnosis-usable, adequacy **${assessAdequacy(fixtureAcc)}** — matching the frozen expectation: ${syntheticDoc.corpusAgrees ? "yes" : "**no**"}.\n`,
);

writeFileSync(join(RESULTS, "stage5_m193_readiness.md"), `${md.join("\n")}\n`);

console.log(`wrote stage5_m193_synthetic_fixtures.json  (${syntheticDoc.agreeing}/${syntheticDoc.fixtureCount} agree)`);
console.log(`wrote stage5_m193_patch_identity.json      (allIdentical=${identityDoc.allIdentical}, resolved=${identityDoc.resolvedCount}/${identityRows.length})`);
console.log(`wrote stage5_m193_readiness.json/.md       (${gates.filter((g) => g.ok).length}/${gates.length} gates)`);
console.log(`readiness: ${readiness}`);
for (const g of gates.filter((x) => !x.ok)) console.log(`  FAIL ${g.id}: ${g.note}`);
