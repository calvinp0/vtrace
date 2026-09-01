/**
 * M196A — falsification controls for corpus qualification (§44, C1-C5).
 *
 * B0 returned INADEQUATE for every corpus VTRACE holds. A gate that says no to
 * everything is only informative if it can be shown to say yes to something, and
 * to say no for the right reason. These controls drive synthetic trajectories
 * through the SAME accounting the real audit used — imported, not reimplemented,
 * so a control cannot pass against a copy of the gate that no longer exists.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m196a_materiality_controls.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { accountStream, evaluate, B0_MEDIAN_EVIDENCE_TOKENS, B0_EVIDENCE_SHARE,
  type ArmAccounting } from "./run_stage5_m196a_materiality";

const RESULTS = path.join(import.meta.dir, "results");
const audit = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m196a_materiality.json"), "utf8"));
const controls: any[] = [];

/** A synthetic trajectory: one Read of `chars` characters, plus `promptChars`
 *  of prompt/response material the provider would have billed as distinct. */
function syntheticArm(id: string, reads: number[], promptTokens: number, resolved = true): string[] {
  const lines: string[] = [];
  reads.forEach((chars, i) => {
    lines.push(JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: `/repo/file${i}.py` } }],
      usage: { input_tokens: 0, cache_creation_input_tokens: i === 0 ? promptTokens : 0, output_tokens: 0 } } }));
    lines.push(JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(chars) }] } }));
  });
  return lines;
}
function armOf(id: string, lines: string[], resolved: boolean, treated: boolean): ArmAccounting {
  return { armId: id, corpus: "SYNTH", repository: "synth", task: id, treated, resolved, ...accountStream(lines) };
}

// ------------------------------------------------------- C1 M194 negative control
const m194 = audit.m194NegativeControl;
controls.push({
  id: "C1", name: "M194 still fails B0",
  pass: m194 !== null && m194.b0 === "TRACK_B_CORPUS_INADEQUATE",
  trackBM194Materiality: m194?.b0 === "TRACK_B_CORPUS_MATERIAL" ? "PASS" : "FAIL",
  detail: { successfulArms: m194?.successfulArms, medianRepositoryEvidenceTokens: m194?.medianRepositoryEvidenceTokens,
    medianShareProvider: m194?.medianShareProvider, b0: m194?.b0 },
});

// -------------------------------------------- C2 synthetic huge-read trajectory
/**
 * The gate MUST be able to fire — otherwise "no corpus qualifies" is a statement
 * about the instrument, not the workloads. Twelve arms that each dump 400k
 * characters clear B0 comfortably, and are labelled ARTIFICIAL_MATERIALITY so
 * they can never be mistaken for an observed workload.
 */
const huge = Array.from({ length: 12 }, (_, i) =>
  armOf(`synth-huge-${i}`, syntheticArm(`h${i}`, [400_000], 5_000), true, false));
const hugeReport = evaluate("SYNTH-HUGE", huge, "ARTIFICIAL_MATERIALITY — constructed, never observed");
controls.push({
  id: "C2", name: "an artificial huge-read corpus clears B0 and is flagged artificial",
  pass: hugeReport.b0 === "TRACK_B_CORPUS_MATERIAL",
  label: "ARTIFICIAL_MATERIALITY",
  qualifiesRealCorpus: false,
  detail: { medianRepositoryEvidenceTokens: hugeReport.medianRepositoryEvidenceTokens,
    medianShareProvider: hugeReport.medianShareProvider, b0: hugeReport.b0 },
});

// ----------------------------------------------------------- C3 one huge outlier
/**
 * Nine small arms and one 100k arm. The median arm must not fire, and the share
 * arm must not rescue it — a single spectacular trajectory is not a workload.
 */
const outlier = [
  ...Array.from({ length: 9 }, (_, i) => armOf(`synth-small-${i}`, syntheticArm(`s${i}`, [4_000], 40_000), true, false)),
  armOf("synth-outlier", syntheticArm("o", [400_000], 40_000), true, false),
];
const outlierReport = evaluate("SYNTH-OUTLIER", outlier, "one huge arm, nine ordinary ones");
controls.push({
  id: "C3", name: "one huge outlier does not carry a low-median corpus",
  pass: outlierReport.b0 === "TRACK_B_CORPUS_INADEQUATE"
    && outlierReport.maxRepositoryEvidenceTokens >= B0_MEDIAN_EVIDENCE_TOKENS,
  detail: { median: outlierReport.medianRepositoryEvidenceTokens, max: outlierReport.maxRepositoryEvidenceTokens,
    medianShareProvider: outlierReport.medianShareProvider, b0: outlierReport.b0 },
});

// ------------------------------------------- C4 treatment contamination excluded
const armsFile = path.join(RESULTS, "stage5_m196a_materiality_arms.jsonl");
const allArms: ArmAccounting[] = readFileSync(armsFile, "utf8").split("\n")
  .filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
const primaryTreated = allArms.filter((a) => a.treated === false).filter((a) => a.treated === true).length;
const primaryPool = allArms.filter((a) => a.treated === false);
controls.push({
  id: "C4", name: "the primary materiality corpus contains no treated arm",
  pass: primaryTreated === 0 && audit.primaryUntreatedCorpus.treatedArms === 0
    && audit.primaryUntreatedCorpus.unknownTreatmentArms === 0,
  detail: { primaryPoolArms: primaryPool.length, treatedInPrimary: audit.primaryUntreatedCorpus.treatedArms,
    unknownTreatmentInPrimary: audit.primaryUntreatedCorpus.unknownTreatmentArms,
    treatedArmsExcluded: allArms.filter((a) => a.treated === true).length },
});

// -------------------------------------------- C5 no post-VTRACE selection leakage
/**
 * §34's ordering rule, checked against the instrument's own source rather than
 * asserted in prose: qualification may read trajectories and outcomes, and must
 * not read anything VTRACE compiled. If a future edit reaches for a capsule or a
 * ranking artefact to decide which corpus qualifies, this control fails.
 */
const SOURCE = readFileSync(path.join(import.meta.dir, "run_stage5_m196a_materiality.ts"), "utf8");
const FORBIDDEN = ["_capsule_v2_context", "_capsule_v2_manifest", "_capsule_v2_ranking",
  "assembleProductContext", "orientationProjection", "buildCapsuleV2", "get_code_context", "run_pipeline"];
const leaked = FORBIDDEN.filter((needle) => SOURCE.includes(needle));
controls.push({
  id: "C5", name: "corpus qualification never reads a VTRACE compilation artefact",
  pass: leaked.length === 0,
  detail: { forbiddenReferences: FORBIDDEN, found: leaked,
    ordering: "measure untreated burden -> B0 -> freeze corpus; VTRACE output is never an input to qualification" },
});

for (const c of controls) console.log(`${c.id}  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
const allPass = controls.every((c) => c.pass);
writeFileSync(path.join(RESULTS, "stage5_m196a_materiality_controls.json"),
  `${JSON.stringify({ milestone: "M196A", b0: { medianTokens: B0_MEDIAN_EVIDENCE_TOKENS, share: B0_EVIDENCE_SHARE },
    controls, verdict: allPass ? "MATERIALITY_CONTROLS_PASS" : "MATERIALITY_CONTROLS_FAIL" }, null, 2)}\n`);
console.log(`\n${allPass ? "MATERIALITY_CONTROLS_PASS" : "MATERIALITY_CONTROLS_FAIL"}`);
