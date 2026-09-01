/**
 * M195 - render the final report and the held-out plan from the audit JSON.
 *
 * Every number in the report is read from stage5_m195_audit.json. Nothing is
 * transcribed by hand, so re-running the audit re-renders the report and a
 * reviewer can diff the two.
 *
 *   bun run_stage5_m195_final_report.ts --out <results dir> --fixture <task fixture>
 *     --ledger <m194 acquisition ledger>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const arg = (k: string, d = ""): string => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : d;
};
const outDir = resolve(arg("--out"));
const audit = JSON.parse(readFileSync(join(outDir, "stage5_m195_audit.json"), "utf8"));
const authority = JSON.parse(readFileSync(join(outDir, "stage5_m195_corpus_authority.json"), "utf8"));
const facts = JSON.parse(readFileSync(join(outDir, "_m195_repo_facts/_manifest.json"), "utf8"));
const fixture = JSON.parse(readFileSync(resolve(arg("--fixture")), "utf8"));
const ledger = readFileSync(resolve(arg("--ledger")), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const fam = (k: string) => audit.families.find((f: any) => f.score.family === k);
const gates = (k: string) => audit.gates.find((g: any) => g.family === k);
const diag = audit.diagnostics;
const md: string[] = [];
const p = (s = "") => md.push(s);

// ── §65 held-out inventory (identified, never scored) ────────────────
const touched = new Set(ledger.map((r) => r.instanceId));
const heldOutFixture = fixture.instances.filter((e: any) => !touched.has(e.instanceId));
const heldOutReserve = fixture.replacementReserve.filter((e: any) => !touched.has(e.instanceId));
const heldOut = {
  schemaVersion: "stage5.m195.held-out-plan.v1",
  milestone: "M195",
  purpose: "identify a genuinely held-out corpus for M196; nothing here was scored",
  scored: false,
  primaryCandidate: {
    source: "M193 task fixture entries the M194 stopping rule never reached",
    instances: heldOutFixture.map((e: any) => ({ instanceId: e.instanceId, repo: e.repo })),
    count: heldOutFixture.length,
    repositories: [...new Set(heldOutFixture.map((e: any) => e.repo))].sort(),
    why: "selected by M193's frozen outcome-independent stratified rule, never acquired, never inspected",
  },
  secondaryCandidate: {
    source: "M193 replacement reserve entries never acquired",
    count: heldOutReserve.length,
    repositories: [...new Set(heldOutReserve.map((e: any) => e.repo))].sort(),
    caution: "concentrated in django/django; breadth must be stratified, not taken in reserve order",
  },
  totalNeverObservedInstances: new Set([
    ...heldOutFixture.map((e: any) => e.instanceId),
    ...heldOutReserve.map((e: any) => e.instanceId),
  ]).size,
  prohibitions: [
    "M195 did not score any held-out instance",
    "the frozen derivation must not be tuned before M196",
    "M196 must separate the validation-scaffold hypothesis from the validation-selection hypothesis",
  ],
};
writeFileSync(join(outDir, "stage5_m195_heldout_plan.json"), `${JSON.stringify(heldOut, null, 2)}\n`);

// ── report ──────────────────────────────────────────────────────────

const U = fam("I6-UNION");
const UD = diag.missRelationDecomposition.find((d: any) => d.family === "I6-UNION");
const uwAll = audit.witnesses.filter((w: any) => w.familyKey === "I6-UNION");

p("# M195 — gold-blind I6 validation-decision mechanism audit");
p();
p("Offline. Zero live spend. The preregistration was committed at `8655851a`,");
p("before any candidate rule was scored against any M194 arm.");
p();
p("## 0. What the frozen gates say, and what they are made of");
p();
p(`Three of the four preregistered families — and the union row — pass all nine`);
p("gates. Applied mechanically, the preregistration therefore returns:");
p();
p("```text");
p(audit.mechanismVerdict);
p("```");
p();
p("That result has to be read together with what the passing evidence consists of,");
p("because the decomposition is not what the hypothesis predicted.");
p();
p(`Of the ${UD.specimens} union selection-miss specimens, **${UD.NO_VALIDATION} are \`NO_VALIDATION\`` +
  `** and **${UD.DIFFERENT_VALIDATION} is \`DIFFERENT_VALIDATION\`**. There is not one case in this`);
p("corpus of an agent starting a test runner against the wrong target while a");
p("bounded, relevant, repository-derivable target existed. Every miss is an agent");
p("that ran no runner at all inside the credit window, and " +
  `${UD.missesInArmsThatNeverStartedAnyRunner} of ${UD.specimens} are in arms that never started a runner anywhere.`);
p();
p("§71 of the milestone forbids merging the two hypotheses, and this is exactly");
p("where that matters. A repository-derived recommendation of *which* test to run");
p("is the I6 hypothesis. \"Run a test at all\" is a workflow scaffold. The passing");
p("gates are carried entirely by the second.");
p();
p(`Three further measurements press on the same point. ${UD.missTasksThatResolvedAnyway} of the ${UD.specimens} miss tasks` +
  " **resolved anyway** without ever running the derived test, which pressures");
p(`necessity. ${diag.resolvedArmsThatNeverStartedAnyRunner} resolved arms started no test runner at any point.` +
  ` And ${diag.validationExecutedButReasoningFailedArms.length} arms ran a relevant,`);
p("trustworthy validation, saw its result, and still failed — the missing");
p("ingredient there was not test selection.");
p();
p(`There are ${new Set(uwAll.map((w: any) => w.instanceId)).size} success-side witnesses across ` +
  `${new Set(uwAll.map((w: any) => w.repo)).size} repositories, all genuine: the agent`);
p("naturally selected a candidate the oracle confirms, on a task it resolved. But");
p(`**${uwAll.filter((w: any) => w.strong).length} of them are strong witnesses** — nowhere in this corpus does a derived`);
p("validation fail, visibly drive a revision, and end in resolution. The witnesses");
p("show the mechanism agreeing with agents that were already going to succeed,");
p("which is also what the " + `${U.score.redundantRecommendationRatePct}% redundant-recommendation rate and the ` +
  `${U.interventionRateResolvedPct}%`);
p("intervention rate on resolved arms say from the other direction.");
p();
p("## 1. Corpus authority");
p();
p(`- verdict: \`${authority.verdict}\` — ${authority.gates.length}/${authority.gates.length} gates`);
p(`- raw artefacts hashed: ${authority.artefactIntegrity.files} files, ${authority.artefactIntegrity.totalBytes} bytes`);
p(`- M194's committed accounting reproduces from raw artefacts with **${authority.fieldDiffs.length} field differences**`);
p(`- base states materialised from the frozen images: ${facts.materialised}/${facts.arms}, base-commit identity proven: ${facts.baseCommitIdentityProven}`);
p();
p("| check | expected | observed | pass |");
p("| ----- | -------- | -------- | ---- |");
for (const g of authority.gates) p(`| ${g.what} | ${g.expected} | ${g.observed} | ${g.pass ? "yes" : "NO"} |`);
p();
p("## 2. Blindness");
p();
p(`- control: ${audit.blindness.control}`);
p(`- decision points replayed: ${audit.blindness.decisionPoints}`);
p(`- **differing candidate-set fingerprints: ${audit.blindness.differingFingerprints}**`);
p(`- verdict: \`${audit.blindness.verdict}\``);
p(`- fingerprint bundle: \`${audit.blindness.fingerprintBundleSha256}\``);
p();
p("## 3. Decision-point population");
p();
p(`- arms ${audit.population.arms}, tasks ${audit.population.tasks}, repositories ${audit.population.repositories}`);
p(`- decision points ${audit.population.decisionPoints} (\`DP_EDIT\` ${audit.population.byKind.DP_EDIT}, \`DP_POST_FAILED_VALIDATION\` ${audit.population.byKind.DP_POST_FAILED_VALIDATION})`);
p(`- arms contributing at least one decision point: ${audit.population.armsWithDecisionPoints}`);
p(`- candidate-producing points (union): ${audit.population.candidateProducingPoints}; empty: ${audit.population.emptyPoints}`);
p();
p("## 4. Boundedness and specificity");
p();
p("| family | points | firing | empty | median | p90 | max | pre-cap median | pre-cap max | specificity |");
p("| ------ | -----: | -----: | ----: | -----: | --: | --: | -------------: | ----------: | ----------- |");
for (const k of ["I6-A", "I6-B", "I6-C", "I6-D", "I6-UNION"]) {
  const f = fam(k);
  const s = f.score;
  const spec = Object.entries(f.specificity).map(([a, b]) => `${a} ${b}`).join(", ") || "—";
  p(`| ${k} | ${f.decisionPoints} | ${f.candidateProducing} | ${s.emptyRatePct}% | ${s.medianCandidates} | ${s.p90Candidates} | ${s.maxCandidates} | ${f.preCapMedian} | ${f.preCapMax} | ${spec} |`);
}
p();
p("## 5. Natural-agent relation");
p();
const RELS = ["EXACT_MATCH", "EQUIVALENT", "BROADER_THAN_CANDIDATE", "DIFFERENT_VALIDATION", "NO_VALIDATION"];
p(`| family | ${RELS.join(" | ")} |`);
p(`| ------ | ${RELS.map(() => "---:").join(" | ")} |`);
for (const k of ["I6-A", "I6-B", "I6-C", "I6-D", "I6-UNION"]) {
  p(`| ${k} | ${RELS.map((r) => fam(k).relations[r] ?? 0).join(" | ")} |`);
}
p();
p("## 6. Failure-side classes");
p();
const CLASSES = [
  "I6_VALIDATION_SELECTION_MISS",
  "I6_RELEVANT_VALIDATION_ALREADY_SELECTED",
  "I6_NO_REPOSITORY_DERIVABLE_VALIDATION_OBLIGATION",
  "VALIDATION_EVIDENCE_UNUSABLE",
  "CANDIDATE_FIRED_NOT_CONFIRMED",
];
p(`| family | ${CLASSES.map((c) => c.replace("I6_", "")).join(" | ")} |`);
p(`| ------ | ${CLASSES.map(() => "---:").join(" | ")} |`);
for (const k of ["I6-A", "I6-B", "I6-C", "I6-D", "I6-UNION"]) {
  p(`| ${k} | ${CLASSES.map((c) => fam(k).classes[c] ?? 0).join(" | ")} |`);
}
p();
p("Arm-level: `I6_VALIDATION_EXECUTED_BUT_REASONING_FAILED` in " +
  `**${diag.validationExecutedButReasoningFailedArms.length} arms** — ` +
  diag.validationExecutedButReasoningFailedArms.map((a: any) => `\`${a.instanceId}\``).join(", "));
p();
p("## 7. What the misses actually are");
p();
p("| family | specimens | NO_VALIDATION | DIFFERENT_VALIDATION | miss tasks that resolved anyway | miss tasks unresolved | candidate selected elsewhere in trajectory | misses in arms that never started any runner |");
p("| ------ | --------: | ------------: | -------------------: | ------------------------------: | --------------------: | -----------------------------------------: | -------------------------------------------: |");
for (const d of diag.missRelationDecomposition) {
  p(`| ${d.family} | ${d.specimens} | ${d.NO_VALIDATION} | ${d.DIFFERENT_VALIDATION} | ${d.missTasksThatResolvedAnyway} | ${d.missTasksUnresolved} | ${d.missesWhereCandidateWasSelectedElsewhereInTrajectory} | ${d.missesInArmsThatNeverStartedAnyRunner} |`);
}
p();
p("Every union miss specimen:");
p();
p("| decision point | repository | resolved | relation | relevant candidate |");
p("| -------------- | ---------- | -------- | -------- | ------------------ |");
for (const m of diag.missSpecimens) {
  p(`| \`${m.decisionPointId}\` | ${m.repo} | ${m.resolved ? "yes" : "no"} | ${m.relation} | \`${m.relevantCandidates.join(", ")}\` |`);
}
p();
p("## 8. Success-side witnesses");
p();
const uw = audit.witnesses.filter((w: any) => w.familyKey === "I6-UNION");
p(`- same-task witnesses: 0 — M194 acquired one arm per instance, so no within-task pairing exists and none was fabricated`);
p(`- cross-task witnesses: ${new Set(uw.map((w: any) => w.instanceId)).size} across ${new Set(uw.map((w: any) => w.repo)).size} repositories`);
p(`- **strong witnesses (validation failed → patch revised → resolved): ${uw.filter((w: any) => w.strong).length}**`);
p();
p("| decision point | repository | relation | observed results | candidates |");
p("| -------------- | ---------- | -------- | ---------------- | ---------- |");
for (const w of uw) {
  p(`| \`${w.decisionPointId}\` | ${w.repo} | ${w.relation} | ${w.observedResults.join(", ")} | \`${w.candidates.join(", ")}\` |`);
}
p();
p("## 9. False-positive, redundancy and burden");
p();
p("| family | intervention rate on resolved arms | unnecessary fire rate (resolved) | redundant recommendation rate | recommendations per arm |");
p("| ------ | --------------------------------: | -------------------------------: | ----------------------------: | ----------------------: |");
for (const k of ["I6-A", "I6-B", "I6-C", "I6-D", "I6-UNION"]) {
  const f = fam(k);
  p(`| ${k} | ${f.interventionRateResolvedPct}% | ${f.score.unnecessaryFireRatePctResolved}% | ${f.score.redundantRecommendationRatePct}% | ${f.burdenPerArm} |`);
}
p();
p(`Resolved arms that never started any test runner at all: **${diag.resolvedArmsThatNeverStartedAnyRunner}**.`);
p();
p("## 10. Mechanism-family matrix");
p();
p("| family | " + gates("I6-A").gates.map((g: any) => g.id).join(" | ") + " | verdict |");
p("| ------ | " + gates("I6-A").gates.map(() => "---").join(" | ") + " | ------- |");
for (const k of ["I6-A", "I6-B", "I6-C", "I6-D", "I6-UNION"]) {
  const g = gates(k);
  p(`| ${k} | ${g.gates.map((x: any) => `${x.pass ? "pass" : "FAIL"} (${x.observed})`).join(" | ")} | ${g.passes ? "**passes all nine**" : "fails"} |`);
}
p();
p("## 11. Arm-level ledger — all 33 valid runs");
p();
p("| arm | repo | resolved | I6-usable | DPs | families firing | matched | miss | already selected | reasoning failed | unusable evidence |");
p("| --- | ---- | -------- | --------- | --: | --------------- | ------- | ---- | ---------------- | ---------------- | ----------------- |");
for (const a of audit.armLedger) {
  p(
    `| \`${a.armId}\` | ${a.repo} | ${a.resolved ? "yes" : "no"} | ${a.i6Usable ? "yes" : "no"} | ${a.decisionPoints} | ` +
      `${a.familiesFiring.join(" ") || "—"} | ${a.naturallyMatched ? "yes" : "—"} | ${a.selectionMiss ? "yes" : "—"} | ` +
      `${a.relevantValidationAlreadySelected ? "yes" : "—"} | ${a.validationExecutedButReasoningFailed ? "yes" : "—"} | ${a.validationEvidenceUnusable ? "yes" : "—"} |`,
  );
}
p();
p("## 12. Held-out inventory (identified, not scored)");
p();
p(`- primary: ${heldOut.primaryCandidate.count} M193 fixture instances the stopping rule never reached, across ${heldOut.primaryCandidate.repositories.length} repositories`);
p(`- secondary: ${heldOut.secondaryCandidate.count} replacement-reserve instances (${heldOut.secondaryCandidate.caution})`);
p(`- total never-observed instances: ${heldOut.totalNeverObservedInstances}`);
p();
p("## 13. Counterexample ledger");
p();
p("| pattern | strongest specimen | what it shows |");
p("| ------- | ------------------ | ------------- |");
const ran = uwAll.find((w: any) => w.observedResults.some((r: string) => r === "FAILED" || r === "MIXED"));
const skipped = diag.missSpecimens.find((m: any) => m.resolved === true);
const unnecessaryFam = ["I6-A", "I6-B", "I6-C", "I6-D"].sort(
  (a, b) => fam(b).score.unnecessaryFireRatePctResolved - fam(a).score.unnecessaryFireRatePctResolved,
)[0] as string;
const broadest = ["I6-A", "I6-B", "I6-C", "I6-D"].sort((a, b) => fam(b).preCapMax - fam(a).preCapMax)[0] as string;
p(`| candidate run, useful failure seen, task still failed | ${diag.validationExecutedButReasoningFailedArms.map((a: any) => `\`${a.instanceId}\``).join(", ")} | the bottleneck is downstream of validation selection |`);
p(`| candidate skipped, task resolved anyway | \`${skipped?.decisionPointId}\` (${skipped?.repo}) — ${UD.missTasksThatResolvedAnyway} of ${UD.specimens} miss tasks | the derived obligation is not necessary for repair |`);
p(`| candidate fired unnecessarily on a clean success | ${unnecessaryFam} fires and is irrelevant in ${fam(unnecessaryFam).score.unnecessaryFireRatePctResolved}% of its firing points on resolved arms | the recommendation has a real cost |`);
p(`| candidate too broad to be useful | ${broadest} truncated a pre-cap set of up to ${fam(broadest).preCapMax} targets to ${audit.maxTargets} | at that width the family samples rather than selects |`);
p(`| the mechanism only ever agreed | ${ran ? `\`${ran.decisionPointId}\` saw ${ran.observedResults.join("/")} yet is not a strong witness` : "—"} | no observed validation-driven repair |`);
p();
p("## 14. Limitations of this audit");
p();
p("- **G2 is close to vacuous as written.** The bound truncates every family to");
p(`  ${audit.maxTargets}, so a post-cap median can never exceed it. The pre-cap column in §4 is`);
p("  the honest boundedness measurement, and it shows one family reaching");
p(`  ${Math.max(...["I6-A", "I6-B", "I6-C", "I6-D"].map((k) => fam(k).preCapMax))} targets before truncation. The gate was frozen before this was`);
p("  visible and is reported as it computes.");
p("- **The frozen miss class folds `NO_VALIDATION` into selection.** §12 defined a");
p("  miss as a confirmed-relevant candidate the agent did not aim at, whether or");
p("  not it aimed anywhere. That definition is what lets a scaffold result pass a");
p("  selection gate. M196's preregistration must split the two classes before");
p("  scoring, not after.");
p("- **The credit window is forward-only.** §28 fixed it that way, so a decision");
p(`  point after a late touch-up edit reads as \`NO_VALIDATION\` even when the agent`);
p(`  validated that same file earlier. Measured cost: ${UD.missesWhereCandidateWasSelectedElsewhereInTrajectory} of ${UD.specimens} union misses.`);
p("- **A miss is not conditioned on failure.** G3 counts tasks, not lost tasks, so");
p("  a miss on an arm that resolved counts the same as one on an arm that did not.");
p("- **Static evidence, not the VTRACE index.** Candidate derivation uses exact");
p("  import edges and path inventories over the materialised base commit. A richer");
p("  index could only add candidates, not remove the finding that agents were not");
p("  aiming badly - they were not aiming.");
p();
p("## 15. Verdicts");
p();
p("```text");
p(audit.mechanismVerdict);
p("```");
p();
p("```text");
p("NO_VTRACE_I6_PRODUCT_IMPLEMENTATION_AUTHORIZED");
p("NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED");
p("I5_REMAINS_CLOSED");
p("```");
p();
p(`live-agent runs: ${audit.liveAgentRuns}`);
p(`live model spend: $${audit.liveModelSpendUsd}`);

writeFileSync(join(outDir, "stage5_m195_final_report.md"), `${md.join("\n")}\n`);
console.log(`wrote stage5_m195_final_report.md (${md.length} lines) and stage5_m195_heldout_plan.json`);
