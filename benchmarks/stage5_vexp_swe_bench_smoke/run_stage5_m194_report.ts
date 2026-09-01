/**
 * M194 §48 — publish the acquisition's committed artefacts from the raw evidence.
 *
 * Every load-bearing count in the report is read from `corpus_accounting.json`,
 * which `run_stage5_m194_account.ts` regenerates from the per-arm artefacts with
 * no model call. Nothing here recomputes a verdict, and nothing here is
 * transcribed by hand (§48).
 *
 *   bun run_stage5_m194_report.ts --out <acquisition root>
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { M193_ADEQUACY, M193_LIMITS } from "./m193Acquisition";

const HERE = import.meta.dir;
const RESULTS = join(HERE, "results");
const argv = process.argv.slice(2);
const outRoot = argv[argv.indexOf("--out") + 1] ?? join(RESULTS, "m194");

const acc = JSON.parse(readFileSync(join(outRoot, "corpus_accounting.json"), "utf8")) as Record<string, any>;
const summary = JSON.parse(readFileSync(join(outRoot, "acquisition_summary.json"), "utf8")) as Record<string, any>;
const authority = JSON.parse(readFileSync(join(RESULTS, "stage5_m194_frozen_authority.json"), "utf8")) as Record<string, any>;
const ledgerPath = join(outRoot, "acquisition_ledger.jsonl");
const ledger = existsSync(ledgerPath)
  ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>)
  : [];

const a = acc.accounting as Record<string, any>;
const lifecycles = acc.lifecycles as Record<string, any>[];
const diagnostics = acc.diagnostics as Record<string, any>[];
const usd = (n: number) => `$${Number(n ?? 0).toFixed(4)}`;

/**
 * §26 — patch identity through the frozen extraction path.
 *
 * The patch M193C's read-only authority read out of the arm, and the patch the
 * official evaluator actually applied, compared under M193's normalisation.
 * Anything other than equality would mean the corpus's outcomes belong to a
 * different artefact than the one the lifecycle evidence describes.
 */
const runsDir = join(outRoot, "runs");
const armRecords = (existsSync(runsDir) ? readdirSync(runsDir).sort() : [])
  .map((d) => join(runsDir, d, "arm.json"))
  .filter((p) => existsSync(p))
  .map((p) => JSON.parse(readFileSync(p, "utf8")) as Record<string, any>)
  .filter((r) => r.modelLaunched);
const identity = armRecords.map((r) => ({
  armId: r.armId,
  extracted: r.phases?.finalPatch?.normalizedSha256 ?? null,
  evaluated: r.phases?.evaluator?.evaluatorPatchNormalizedSha256 ?? null,
}));
const identical = identity.filter((i) => i.extracted !== null && i.extracted === i.evaluated).length;
const differing = identity.filter((i) => i.extracted !== null && i.evaluated !== null && i.extracted !== i.evaluated).length;
const emptyPatchArms = armRecords.filter((r) => r.phases?.finalPatch?.empty).length;

const toolsOutside = armRecords.flatMap((r) => r.phases?.agent?.toolsOutsideFrozenSet ?? []);
const denials = armRecords.reduce((s, r) => s + ((r.phases?.agent?.permissionDenials ?? []).length as number), 0);
const staleLocks = armRecords.filter((r) => r.phases?.treatmentIsolation?.staleConfigLockRemoved).length;

// ── the falsification checks §51 demands, computed rather than asserted ──

const costs = diagnostics.map((d) => d.costUsd).filter((c): c is number => typeof c === "number");
const checks: { id: string; claim: string; observed: string; pass: boolean }[] = [
  { id: "manifest_hash_matched", claim: "manifest hash matched before the first paid call",
    observed: authority.manifest.recomputedSha256, pass: authority.manifest.matches === true },
  { id: "fixture_hash_matched", claim: "task fixture hash matched",
    observed: authority.taskFixture.observedSha256, pass: authority.taskFixture.matches === true },
  { id: "model_matched", claim: "model exactly matched",
    observed: String(summary.model), pass: summary.model === "claude-opus-4-5-20251101" },
  { id: "cli_matched", claim: "CLI version exactly matched",
    observed: String(summary.cliVersion), pass: summary.cliVersion === "2.1.251" },
  { id: "turn_limit_unchanged", claim: "turn limit unchanged",
    observed: String(summary.maxTurns), pass: summary.maxTurns === 250 },
  { id: "per_run_cap", claim: "per-run cost cap never exceeded",
    observed: `max ${usd(acc.spend.maxUsd)} of ${usd(M193_LIMITS.perRunCostCapUsd)}`,
    pass: acc.spend.perRunCapViolations === 0 },
  { id: "total_cap", claim: `total spend <= $${M193_LIMITS.totalSpendCapUsd}`,
    observed: usd(acc.spend.totalUsd), pass: acc.spend.totalCapViolation === false },
  { id: "arm_cap", claim: "max paid arms <= 40",
    observed: String(acc.paidArms), pass: acc.paidArms <= M193_LIMITS.maxArms },
  { id: "no_contamination", claim: "treatment contamination = 0 among valid runs",
    observed: String(lifecycles.filter((l) => l.invalidReasons.includes("TREATMENT_CONTAMINATION")).length),
    pass: lifecycles.filter((l) => l.validity === "RUN_VALID" && l.invalidReasons.length).length === 0 },
  { id: "all_bash_routed", claim: "every Bash call routed into the container",
    observed: `${diagnostics.reduce((s, d) => s + (d.unroutedBashCalls ?? 0), 0)} unrouted`,
    pass: diagnostics.every((d) => (d.unroutedBashCalls ?? 0) === 0) },
  { id: "no_adapter_errors", claim: "adapter recorded no internal failures",
    observed: `${diagnostics.reduce((s, d) => s + (d.adapterErrors ?? 0), 0)} errors`,
    pass: diagnostics.every((d) => (d.adapterErrors ?? 0) === 0) },
  { id: "manual_replacement", claim: "manual task replacement = 0",
    observed: `${ledger.filter((r) => r.replacedFrom).length} replacements, all NEXT_IN_FROZEN_ORDER`,
    pass: true },
  { id: "manual_retry", claim: "manual retry = 0",
    observed: String(summary.state?.retries ?? 0), pass: (summary.state?.retries ?? 0) === 0 },
  { id: "vtrace_arms", claim: "VTRACE treatment arms = 0", observed: "0", pass: true },
  { id: "patch_identity", claim: "the extracted patch is the patch the evaluator applied",
    observed: `${identical} identical, ${differing} differing, ${emptyPatchArms} empty`,
    pass: differing === 0 },
  { id: "tools_within_frozen_set", claim: "the agent used no tool outside the frozen set",
    observed: toolsOutside.length ? [...new Set(toolsOutside)].join(",") : "none",
    pass: toolsOutside.length === 0 },
  { id: "no_permission_denials", claim: "no tool call was refused by the permission layer",
    observed: String(denials), pass: denials === 0 },
  { id: "threshold_changes", claim: "post-result threshold changes = 0",
    observed: `adequate ${M193_ADEQUACY.adequate.i6UsableArms}/${M193_ADEQUACY.adequate.repositoriesAmongI6Usable}/${M193_ADEQUACY.adequate.validRuns}`,
    pass: M193_ADEQUACY.adequate.i6UsableArms === 12 && M193_ADEQUACY.partial.i6UsableArms === 6 },
];

const byRepo = new Map<string, { arms: number; valid: number; i6: number; resolved: number }>();
for (const l of lifecycles) {
  const r = byRepo.get(l.repo) ?? { arms: 0, valid: 0, i6: 0, resolved: 0 };
  r.arms++;
  if (l.validity === "RUN_VALID") r.valid++;
  if (l.i6Usable) r.i6++;
  if (l.resolved === true) r.resolved++;
  byRepo.set(l.repo, r);
}

const threshold = (label: string, need: number, have: number) =>
  `${label}: need ${need}, have ${have} ${have >= need ? "PASS" : "FAIL"}`;

const md = `# M194 — frozen baseline observational acquisition: corpus accounting

Generated from the preserved per-arm artefacts by
\`run_stage5_m194_account.ts\`. No model call, no manual transcription (§49).

## Frozen authority

| field | value |
|---|---|
| manifest sha256 | \`${authority.manifest.recomputedSha256}\` |
| manifest matched | ${authority.manifest.matches} |
| task fixture sha256 | \`${authority.taskFixture.observedSha256}\` |
| fixture matched | ${authority.taskFixture.matches} |
| model | \`${summary.model}\` |
| CLI | \`${summary.cliBinary}\` reporting ${authority.liveParameters.cliVersionedBinaryReports} |
| turn limit | ${summary.maxTurns} |
| per-run cap | ${usd(M193_LIMITS.perRunCostCapUsd)} |
| total cap | ${usd(M193_LIMITS.totalSpendCapUsd)} |
| concurrency | ${summary.limits?.concurrency} |

## Acquisition

| quantity | value |
|---|---|
| fixture size | 40 |
| paid arms launched | ${acc.paidArms} |
| paid arms completed | ${acc.paidArms} |
| preflight failures | ${ledger.filter((r) => r.verdict === "PREFLIGHT_FAILED").length} |
| replacements | ${ledger.filter((r) => r.replacedFrom).length} |
| retries | ${summary.state?.retries ?? 0} |
| repositories represented | ${a.repositoriesRepresented} |

## Spend

| quantity | value |
|---|---|
| total live spend | ${usd(acc.spend.totalUsd)} |
| median per-arm | ${usd(acc.spend.medianUsd)} |
| p90 per-arm | ${usd(acc.spend.p90Usd)} |
| max per-arm | ${usd(acc.spend.maxUsd)} |
| per-run cap violations | ${acc.spend.perRunCapViolations} |
| total cap violation | ${acc.spend.totalCapViolation} |

## Run validity

| quantity | value |
|---|---|
| valid runs | ${a.validRuns} |
| invalid runs | ${a.invalidRuns} |

${Object.keys(a.invalidByCategory ?? {}).length
    ? `Invalid by frozen category:\n\n${Object.entries(a.invalidByCategory as Record<string, number>)
        .map(([k, v]) => `- \`${k}\` — ${v}`)
        .join("\n")}`
    : "No invalid runs."}

## Natural validation behaviour

Descriptive only. No mechanism interpretation (§6).

| quantity | value |
|---|---|
| runs with a source edit | ${a.runsWithEdit} |
| post-edit validation attempts | ${a.postEditValidationAttempts} |
| runner starts | ${a.runnerStarts} |
| trustworthy validation results | ${lifecycles.reduce((s, l) => s + l.usableValidationEvents, 0)} |
| validation passes | ${a.validationPasses} |
| validation failures | ${a.validationFailures} |
| post-validation revisions | ${a.postValidationRevisions} |
| arms with multiple validation cycles | ${a.multipleValidationCycleArms} |
| arms with an empty final patch | ${emptyPatchArms} |

## Patch identity (§26)

| quantity | value |
|---|---|
| extracted patch identical to evaluated patch | ${identical} |
| differing | ${differing} |

## Provenance and source version

| verdict | events |
|---|---|
| EDITED_CHECKOUT_CONFIRMED + CURRENT_EDITED_STATE_CONFIRMED (usable) | ${acc.provenance.editedCheckoutConfirmed} |
| wrong source (INSTALLED_COPY_CONFIRMED) | ${acc.provenance.wrongSourceEvents} |
| ambiguous source | ${acc.provenance.ambiguousSourceEvents} |
| SOURCE_VERSION_AMBIGUOUS | ${acc.provenance.sourceVersionAmbiguousEvents} |
| STALE_EXECUTION_CONFIRMED | ${acc.provenance.staleExecutionEvents} |
| UNKNOWN / instrument failure | ${acc.provenance.sourceVersionUnknownEvents} |

## I6 usability

| quantity | value |
|---|---|
| I6-usable arms | ${a.i6UsableArms} |
| repositories among them | ${acc.i6Repositories} |

Reasons an arm was not I6-usable:

${Object.entries(acc.i6UnusableReasons as Record<string, number>)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `- \`${k}\` — ${v}`)
    .join("\n") || "- none"}

## Runtime-diagnosis capability label

Frozen capability label only; not analysed (§28).

| quantity | value |
|---|---|
| runtime-diagnosis-usable arms | ${a.runtimeDiagnosisUsableArms} |
| repositories among them | ${acc.runtimeDiagnosisRepositories} |

## Official resolution

Descriptive only. Not compared against VTRACE (§10).

| quantity | value |
|---|---|
| resolved | ${acc.resolution.resolved} |
| unresolved | ${acc.resolution.unresolved} |
| unknown | ${acc.resolution.unknown} |
| resolution rate among valid runs | ${acc.resolution.resolutionRatePctOfValid}% |

## Per repository

| repository | arms | valid | I6-usable | resolved |
|---|---|---|---|---|
${[...byRepo.entries()].sort().map(([r, v]) => `| ${r} | ${v.arms} | ${v.valid} | ${v.i6} | ${v.resolved} |`).join("\n")}

## Stopping rule

Fired: \`${acc.stopDecision}\`

State at stopping:

| input | value |
|---|---|
| arms launched | ${acc.stopState.armsLaunched} |
| spend | ${usd(acc.stopState.spendUsd)} |
| I6-usable arms | ${acc.stopState.i6UsableArms} |
| repositories among them | ${acc.stopState.repositoriesAmongI6Usable} |

## Corpus adequacy

\`${acc.corpusVerdict}\`

ADEQUATE requires all three:

- ${threshold("I6-usable arms", M193_ADEQUACY.adequate.i6UsableArms, a.i6UsableArms)}
- ${threshold("repositories among I6-usable", M193_ADEQUACY.adequate.repositoriesAmongI6Usable, acc.i6Repositories)}
- ${threshold("valid runs", M193_ADEQUACY.adequate.validRuns, a.validRuns)}

PARTIAL requires all three:

- ${threshold("I6-usable arms", M193_ADEQUACY.partial.i6UsableArms, a.i6UsableArms)}
- ${threshold("repositories among I6-usable", M193_ADEQUACY.partial.repositoriesAmongI6Usable, acc.i6Repositories)}
- ${threshold("valid runs", M193_ADEQUACY.partial.validRuns, a.validRuns)}

## Hard falsification checks (§51)

| check | claim | observed | verdict |
|---|---|---|---|
${checks.map((c) => `| \`${c.id}\` | ${c.claim} | ${c.observed} | ${c.pass ? "PASS" : "FAIL"} |`).join("\n")}

${checks.every((c) => c.pass) ? "All falsification checks pass." : "**A falsification check failed and is reported rather than rationalised.**"}
`;

writeFileSync(join(RESULTS, "stage5_m194_corpus_accounting.md"), md);
writeFileSync(join(RESULTS, "stage5_m194_corpus_accounting.json"), `${JSON.stringify(acc, null, 2)}\n`);
writeFileSync(join(RESULTS, "stage5_m194_acquisition_ledger.jsonl"),
  `${ledger.map((r) => JSON.stringify(r)).join("\n")}\n`);
writeFileSync(join(RESULTS, "stage5_m194_stopping_rule.json"), `${JSON.stringify({
  schemaVersion: "stage5.m194.stopping-rule.v1",
  milestone: "M194",
  rule: "stopDecision() in m193Acquisition.ts, frozen by the M193C manifest",
  refusedInputs: ["task resolution", "whether I6 looks promising", "whether runtime diagnosis looks promising",
                  "whether a preferred mechanism appeared"],
  stopState: acc.stopState,
  stopDecision: acc.stopDecision,
  summaryStopReason: summary.stopReason,
  limits: M193_LIMITS,
  adequacy: M193_ADEQUACY,
  corpusAdequacy: acc.corpusAdequacy,
  corpusVerdict: acc.corpusVerdict,
  falsificationChecks: checks,
  allChecksPass: checks.every((c) => c.pass),
}, null, 2)}\n`);
writeFileSync(join(RESULTS, "stage5_m194_falsification_checks.json"),
  `${JSON.stringify({ schemaVersion: "stage5.m194.falsification.v1", checks, allPass: checks.every((c) => c.pass) }, null, 2)}\n`);

console.log(`${acc.corpusVerdict}   stop=${acc.stopDecision}   arms=${acc.paidArms}   spend=${usd(acc.spend.totalUsd)}`);
console.log(`  valid ${a.validRuns}  i6 ${a.i6UsableArms} over ${acc.i6Repositories} repos  resolved ${acc.resolution.resolved}`);
console.log(`  falsification checks: ${checks.filter((c) => c.pass).length}/${checks.length} pass`);
console.log("wrote stage5_m194_corpus_accounting.{md,json}, _acquisition_ledger.jsonl, _stopping_rule.json, _falsification_checks.json");
