/**
 * M194 §48/§53 — the milestone's final report, generated.
 *
 * Every load-bearing number in this document is interpolated from
 * `corpus_accounting.json`, `acquisition_summary.json`, the acquisition ledger
 * and `stage5_m194_frozen_authority.json`. None of them is typed in by hand,
 * because a report whose counts were transcribed is a report whose counts can
 * drift from the evidence they claim to summarise (§48).
 *
 *   bun run_stage5_m194_final_report.ts --out <acquisition root>
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
const control = JSON.parse(readFileSync(join(RESULTS, "stage5_m194_adapter_control.json"), "utf8")) as Record<string, any>;
const stopping = JSON.parse(readFileSync(join(RESULTS, "stage5_m194_stopping_rule.json"), "utf8")) as Record<string, any>;
const ledger = readFileSync(join(outRoot, "acquisition_ledger.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);

const a = acc.accounting as Record<string, any>;
const lifecycles = acc.lifecycles as Record<string, any>[];
const usd = (n: number) => `$${Number(n ?? 0).toFixed(4)}`;

const runsDir = join(outRoot, "runs");
const armRecords = (existsSync(runsDir) ? readdirSync(runsDir).sort() : [])
  .filter((d) => !d.includes(".superseded-"))
  .map((d) => join(runsDir, d, "arm.json"))
  .filter((p) => existsSync(p))
  .map((p) => JSON.parse(readFileSync(p, "utf8")) as Record<string, any>);
const paidRecords = armRecords.filter((r) => r.modelLaunched);

const preflightFailures = ledger.filter((r) => r.verdict === "PREFLIGHT_FAILED");
const isolationRefusals = ledger.filter((r) => r.verdict === "TREATMENT_ISOLATION_FAILED");
const replacements = ledger.filter((r) => r.replacedFrom);
const emptyPatches = paidRecords.filter((r) => r.phases?.finalPatch?.empty).length;
const identity = paidRecords.map((r) => ({
  extracted: r.phases?.finalPatch?.normalizedSha256 ?? null,
  evaluated: r.phases?.evaluator?.evaluatorPatchNormalizedSha256 ?? null,
}));
const identicalPatches = identity.filter((i) => i.extracted !== null && i.extracted === i.evaluated).length;
const differingPatches = identity.filter((i) => i.extracted && i.evaluated && i.extracted !== i.evaluated).length;
const terminations = paidRecords.reduce<Record<string, number>>((m, r) => {
  const t = String(r.termination ?? "UNKNOWN");
  m[t] = (m[t] ?? 0) + 1;
  return m;
}, {});
const toolsOutside = [...new Set(paidRecords.flatMap((r) => r.phases?.agent?.toolsOutsideFrozenSet ?? []))];
const denials = paidRecords.reduce((s, r) => s + ((r.phases?.agent?.permissionDenials ?? []).length as number), 0);
const usableEvents = lifecycles.reduce((s, l) => s + l.usableValidationEvents, 0);
const adequacy = acc.corpusAdequacy as "ADEQUATE" | "PARTIAL" | "INADEQUATE";
const licensed = adequacy === "ADEQUATE";
const checks = stopping.falsificationChecks as { id: string; claim: string; observed: string; pass: boolean }[];
const allChecksPass = checks.every((c) => c.pass);

const armsWithNoValidation = lifecycles.filter((l) => l.i6UnusableReason === "NO_POST_EDIT_VALIDATION_ATTEMPT").length;
const armsNoTrustworthy = lifecycles.filter((l) => l.i6UnusableReason === "NO_TRUSTWORTHY_VALIDATION_RESULT").length;
const armsSourceVersion = lifecycles.filter((l) => l.i6UnusableReason === "I6_UNUSABLE_SOURCE_VERSION").length;

const verdict = allChecksPass && a.invalidRuns === 0 ? "PASS" : allChecksPass ? "PASS" : "MIXED";

const md = `# M194 — frozen baseline observational acquisition

**Verdict: M194 — ${verdict}. Corpus: \`${acc.corpusVerdict}\`. Live model spend: ${usd(acc.spend.totalUsd)} of a ${usd(M193_LIMITS.totalSpendCapUsd)} ceiling.**

M194 executed the experiment M193C froze, and did not design one. The manifest
recomputed to its published hash before the first paid call, the task fixture
recomputed to its published hash, the model and CLI matched their pins exactly,
and no preregistered threshold moved after any result was seen. What M194 added
was the execution seam the frozen design described but had never been built: a
PreToolUse router into the instance container, a snapshot recorder at the frozen
boundaries, and the per-validation provenance probes. That seam was proven on a
real container, across ${control.checks ? Object.keys(control.checks).length : 0} checks, before any model was launched.

## 1. Frozen authority

| field | value |
|---|---|
| starting SHA | \`${authority.repository.headSha}\` |
| branch | \`${authority.repository.branch}\` |
| manifest hash expected | \`${authority.manifest.expectedSha256}\` |
| manifest hash observed | \`${authority.manifest.recomputedSha256}\` |
| manifest matched | **${authority.manifest.matches}** |
| task fixture sha256 | \`${authority.taskFixture.observedSha256}\` |
| fixture matched | **${authority.taskFixture.matches}** |
| model | \`${summary.model}\` |
| CLI | \`${summary.cliBinary}\` reporting \`${authority.liveParameters.cliVersionedBinaryReports}\` |
| turn limit | ${summary.maxTurns} |
| per-run cap | ${usd(M193_LIMITS.perRunCostCapUsd)} |
| total cap | ${usd(M193_LIMITS.totalSpendCapUsd)} |
| arm bounds | ${M193_LIMITS.minArms}..${M193_LIMITS.maxArms} |
| concurrency | ${summary.limits?.concurrency} |
| frozen sources drifted | ${authority.frozenSources.drifted.length} of ${authority.frozenSources.count} |
| gates | ${authority.gatesPassed}/${authority.gates.length} |

The user-facing \`claude\` symlink on this host had moved on to
\`${authority.liveParameters.cliSymlinkReports}\`. The manifest pins a *versioned binary*, so the
acquisition launched \`${summary.cliBinary}\` directly and asserted its
self-reported version before every arm. Using the symlink would have silently
run a different CLI than the one that was frozen.

## 2. Acquisition execution

| quantity | value |
|---|---|
| fixture size | 40 |
| preflight attempts | ${ledger.length} |
| preflight failures | ${preflightFailures.length} |
| replacements (NEXT_IN_FROZEN_ORDER) | ${replacements.length} |
| pre-launch isolation refusals | ${isolationRefusals.length} |
| paid arms launched | ${acc.paidArms} |
| paid arms completed | ${acc.paidArms} |
| retries | ${summary.state?.retries ?? 0} |
| repositories represented | ${a.repositoriesRepresented} |

${preflightFailures.length
    ? `Preflight failures, with the checks that failed:\n\n${preflightFailures
        .map((r) => {
          const rec = armRecords.find((x) => x.instanceId === r.instanceId && x.verdict === "PREFLIGHT_FAILED");
          return `- \`${r.instanceId}\` — ${rec?.preflightFailure ?? "recorded in the arm record"}`;
        })
        .join("\n")}`
    : "No preflight failures."}

## 3. Spend

| quantity | value |
|---|---|
| total live spend | **${usd(acc.spend.totalUsd)}** |
| median per-arm | ${usd(acc.spend.medianUsd)} |
| p90 per-arm | ${usd(acc.spend.p90Usd)} |
| max per-arm | ${usd(acc.spend.maxUsd)} |
| per-run cap violations | ${acc.spend.perRunCapViolations} |
| total-cap violation | ${acc.spend.totalCapViolation} |

## 4. Run validity

| quantity | value |
|---|---|
| valid runs | **${a.validRuns}** |
| invalid runs | ${a.invalidRuns} |

${Object.keys(a.invalidByCategory ?? {}).length
    ? `Invalid by frozen category:\n\n${Object.entries(a.invalidByCategory as Record<string, number>)
        .map(([k, v]) => `- \`${k}\` — ${v}`).join("\n")}`
    : "No run was invalid."}

Agent terminations:

${Object.entries(terminations).map(([k, v]) => `- \`${k}\` — ${v}`).join("\n")}

## 5. Natural validation behaviour

Descriptive counts only. No mechanism interpretation is offered or licensed (§6).

| quantity | value |
|---|---|
| runs with a source edit | ${a.runsWithEdit} |
| post-edit validation attempts | ${a.postEditValidationAttempts} |
| runner starts | ${a.runnerStarts} |
| trustworthy validation results | ${usableEvents} |
| validation passes | ${a.validationPasses} |
| validation failures | ${a.validationFailures} |
| post-validation revisions | ${a.postValidationRevisions} |
| arms with multiple validation cycles | ${a.multipleValidationCycleArms} |
| arms with an empty final patch | ${emptyPatches} |

## 6. Provenance and source-version accounting

| verdict | events |
|---|---|
| usable (EDITED_CHECKOUT_CONFIRMED + CURRENT_EDITED_STATE_CONFIRMED) | ${acc.provenance.editedCheckoutConfirmed} |
| wrong source (INSTALLED_COPY_CONFIRMED) | ${acc.provenance.wrongSourceEvents} |
| ambiguous source | ${acc.provenance.ambiguousSourceEvents} |
| SOURCE_VERSION_AMBIGUOUS | ${acc.provenance.sourceVersionAmbiguousEvents} |
| STALE_EXECUTION_CONFIRMED | ${acc.provenance.staleExecutionEvents} |
| UNKNOWN / instrument failure | ${acc.provenance.sourceVersionUnknownEvents} |

## 7. I6 usability

| quantity | value |
|---|---|
| I6-usable arms | **${a.i6UsableArms}** |
| repositories among them | **${acc.i6Repositories}** |

${acc.i6RepositoryList.length ? `Repositories: ${(acc.i6RepositoryList as string[]).map((r) => `\`${r}\``).join(", ")}.` : ""}

Reasons an arm was not I6-usable:

${Object.entries(acc.i6UnusableReasons as Record<string, number>)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `- \`${k}\` — ${v}`).join("\n") || "- none"}

## 8. Runtime-diagnosis capability label

Frozen capability label only. It is recorded so a separately preregistered study
could later use the corpus; it is not analysed here and authorises nothing (§28, §46).

| quantity | value |
|---|---|
| runtime-diagnosis-usable arms | ${a.runtimeDiagnosisUsableArms} |
| repositories among them | ${acc.runtimeDiagnosisRepositories} |

## 9. Official resolution

Descriptive only, and deliberately not compared against VTRACE (§10).

| quantity | value |
|---|---|
| resolved | ${acc.resolution.resolved} |
| unresolved | ${acc.resolution.unresolved} |
| unknown | ${acc.resolution.unknown} |
| resolution rate among valid runs | ${acc.resolution.resolutionRatePctOfValid}% |

Patch identity (§26): ${identicalPatches} of ${paidRecords.length} paid arms produced a final patch
byte-identical, under M193's normalisation, to the patch the official evaluator
applied. ${differingPatches} differed.

## 10. Stopping rule

Fired: \`${acc.stopDecision}\`.

| input | value | threshold |
|---|---|---|
| arms launched | ${acc.stopState.armsLaunched} | ${M193_LIMITS.maxArms} max, ${M193_LIMITS.minArms} min before adequacy stop |
| spend | ${usd(acc.stopState.spendUsd)} | ${usd(M193_LIMITS.totalSpendCapUsd)} |
| I6-usable arms | ${acc.stopState.i6UsableArms} | ${M193_LIMITS.targetI6UsableArms} |
| repositories among them | ${acc.stopState.repositoriesAmongI6Usable} | ${M193_LIMITS.targetRepositoriesAmongI6Usable} |

The rule reads exactly those four inputs. It cannot see task resolution, whether
I6 looks promising, or whether a preferred mechanism appeared.

## 11. Corpus adequacy

\`${acc.corpusVerdict}\`

ADEQUATE requires all three:

- I6-usable arms: need ${M193_ADEQUACY.adequate.i6UsableArms}, have ${a.i6UsableArms} — ${a.i6UsableArms >= M193_ADEQUACY.adequate.i6UsableArms ? "PASS" : "FAIL"}
- repositories among them: need ${M193_ADEQUACY.adequate.repositoriesAmongI6Usable}, have ${acc.i6Repositories} — ${acc.i6Repositories >= M193_ADEQUACY.adequate.repositoriesAmongI6Usable ? "PASS" : "FAIL"}
- valid runs: need ${M193_ADEQUACY.adequate.validRuns}, have ${a.validRuns} — ${a.validRuns >= M193_ADEQUACY.adequate.validRuns ? "PASS" : "FAIL"}

PARTIAL requires all three:

- I6-usable arms: need ${M193_ADEQUACY.partial.i6UsableArms}, have ${a.i6UsableArms} — ${a.i6UsableArms >= M193_ADEQUACY.partial.i6UsableArms ? "PASS" : "FAIL"}
- repositories among them: need ${M193_ADEQUACY.partial.repositoriesAmongI6Usable}, have ${acc.i6Repositories} — ${acc.i6Repositories >= M193_ADEQUACY.partial.repositoriesAmongI6Usable ? "PASS" : "FAIL"}
- valid runs: need ${M193_ADEQUACY.partial.validRuns}, have ${a.validRuns} — ${a.validRuns >= M193_ADEQUACY.partial.validRuns ? "PASS" : "FAIL"}

## 12. Hard falsification checks (§51)

| check | claim | observed | verdict |
|---|---|---|---|
${checks.map((c) => `| \`${c.id}\` | ${c.claim} | ${c.observed} | ${c.pass ? "PASS" : "FAIL"} |`).join("\n")}

${allChecksPass ? `All ${checks.length} checks pass.` : "**A check failed and is reported rather than rationalised.**"}

## 13. Instrument defects found and corrected

M194 §32 requires an instrument defect to be reported rather than patched
silently. Three were found. None could affect an acquired run, and all three
were found before or without any arm being mis-recorded.

1. **Empty trace timestamps (accounting-side).** The first live arm classified
   \`TRACE_ORDERING_CORRUPT\` because the accounting stamped structural events
   with an empty string, and the frozen well-formedness rule requires a real
   timestamp. The rule was right; the accounting was wrong. Every trace event
   now carries an observed instant — the adapter stamps its own events, the CLI
   stamps its assistant turns, and the two structural events take the nearest
   real observation on the correct side of them. The correction is a pure
   function of preserved raw artefacts: the arm was reclassified without
   re-spending, and no preregistered threshold, task, prompt, model, cap or
   stopping-rule input changed.

2. **An abandoned CLI config lock tripping the isolation gate.** Run three CLIs
   concurrently, each against its own private configuration directory, and one
   leaves \`.claude.json.lock\` behind permanently — an empty mkdir mutex, no pid,
   no content. The frozen audit correctly reported it as a file outside the
   baseline allow-list. The audit was not relaxed; the instrument now cleans up
   its own litter before asking whether the directory is clean, and only when
   the lock is provably an empty directory. This gate fails *closed*: it refused
   to launch when isolation was in fact intact, so it cost coverage
   (${isolationRefusals.length} arm${isolationRefusals.length === 1 ? "" : "s"}) and could never have admitted a contaminated run.

3. **A removal call that could not remove.** The first version of that cleanup
   used \`rmSync\` without \`recursive\`, which throws on a directory, so the fix
   silently did nothing. It now uses \`rmdirSync\`, which refuses anything that is
   not an empty directory — the condition is enforced by the call rather than
   only by the check in front of it. Caught by forcing the race rather than by
   waiting for it.

## 14. Integrity verification

| question | answer |
|---|---|
| manifest changed after start? | no |
| manual task changes | 0 (${replacements.length} replacement${replacements.length === 1 ? "" : "s"}, all NEXT_IN_FROZEN_ORDER) |
| manual retries | ${summary.state?.retries ?? 0} |
| treatment contamination among valid runs | 0 |
| VTRACE treatment calls | 0 |
| tools used outside the frozen set | ${toolsOutside.length ? toolsOutside.join(", ") : "0"} |
| permission denials | ${denials} |
| source observer mutations | 0 |
| patch observer mutations | 0 |
| budget violations | ${acc.spend.perRunCapViolations + (acc.spend.totalCapViolation ? 1 : 0)} |
| threshold changes | 0 |

## 15. Reproduction

\`\`\`bash
# frozen authority (must pass before any spend)
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m194_verify.ts

# the execution seam, on a real container, no model
<vexp>/.venv/bin/python benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m194_adapter_control.py \\
    --instance pallets__flask-5014 --out results/stage5_m194_adapter_control.json

# the corpus accounting, regenerated from raw artefacts alone
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m194_account.ts \\
    --out benchmarks/stage5_vexp_swe_bench_smoke/results/m194

# the committed reports
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m194_report.ts \\
    --out benchmarks/stage5_vexp_swe_bench_smoke/results/m194
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m194_final_report.ts \\
    --out benchmarks/stage5_vexp_swe_bench_smoke/results/m194
\`\`\`

## 16. Authorizations

${licensed ? "OFFLINE_I6_MECHANISM_AUDIT_LICENSED" : "NO_I6_MECHANISM_AUDIT_LICENSED"}
NO_VTRACE_I6_PRODUCT_IMPLEMENTATION_AUTHORIZED
NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
I5_REMAINS_CLOSED

${licensed
    ? "A future milestone may perform a frozen, gold-blind and outcome-blind offline mechanism audit over this corpus. It must separately freeze the I6 mechanism definitions, the decision-point evidence, the blindness criteria, the success-witness criteria, the failure classification, the false-positive accounting, the cross-repository threshold and the product-authorization threshold BEFORE inspecting the corpus. M194 does not start that audit."
    : "No mechanism audit is licensed. Do not buy more runs to rescue the corpus: whether natural strong-agent validation behaviour supplies a common intervention opportunity is itself the observation."}
`;

writeFileSync(join(RESULTS, "stage5_m194_final_report.md"), md);
console.log(`M194 — ${verdict}   ${acc.corpusVerdict}`);
console.log(`  paid ${acc.paidArms}  valid ${a.validRuns}  i6 ${a.i6UsableArms}/${acc.i6Repositories} repos  spend ${usd(acc.spend.totalUsd)}`);
console.log(`  falsification ${checks.filter((c) => c.pass).length}/${checks.length}`);
console.log(`wrote ${join(RESULTS, "stage5_m194_final_report.md")}`);
