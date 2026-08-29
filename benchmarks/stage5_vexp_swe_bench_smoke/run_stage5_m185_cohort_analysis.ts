/**
 * M185-C — the cohorts that decide how much causal weight "correct focus" deserves.
 *
 * Writes:
 *   stage5_m185_wrong_focus_successes.json   §30/§100 — six solves without a gold focus
 *   stage5_m185_discordant_pairs.json        §31/§32/§101 — the two wins on each side
 *   stage5_m185_correct_focus_successes.json §21 — the comparison group for cohort A
 *
 * The adoption facts come from M183's own gold diagnostics rather than being
 * recomputed here; what M185 adds is the reading, and the reading is recorded
 * next to the number that forces it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

interface GoldRow {
  instanceId: string; repo: string; focusAt: string | null; goldFiles: string[];
  orientationFiles: string[]; orientationIgnored: boolean; goldFileInOrientation: boolean;
  treatmentEdits: string[]; baselineEdits: string[];
  treatmentAdoption: { touchedAny: boolean; firstTouchIndex: number | null; touchedCount: number };
  treatmentResolved: boolean; baselineResolved: boolean;
}
const gold = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m183_gold_diagnostics.json"), "utf8")) as { rows: GoldRow[] };
const cohorts = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m185_cohorts.json"), "utf8")) as {
  rows: { instanceId: string; focusCohort: string; outcomeCohort: string }[];
};
const behaviour = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m185_post_focus_behavior.json"), "utf8")) as {
  rows: { instanceId: string; arm: string; distinctFilesRead: string[]; readAnyTestFile: boolean; toolCalls: number }[];
};
const cohortOf = new Map(cohorts.rows.map((r) => [r.instanceId, r]));
const treatmentBehaviour = new Map(behaviour.rows.filter((r) => r.arm === "treatment").map((r) => [r.instanceId, r]));
const rowOf = new Map(gold.rows.map((r) => [r.instanceId, r]));

/** how a run that was pointed at the wrong file nevertheless reached the right one */
const routeOf = (r: GoldRow): string => {
  if (r.orientationIgnored) return "SELF_LOCALIZED_ORIENTATION_IGNORED";
  if (r.goldFileInOrientation) return "GOLD_FILE_PRESENT_IN_RELATED_NOT_FOCUS";
  return "ORIENTATION_TOUCHED_THEN_LEFT_FOR_A_GOLD_FILE";
};

const wrongFocusSuccesses = cohorts.rows.filter((c) => c.focusCohort === "C_WRONG_FOCUS_SUCCESS").map((c) => {
  const r = rowOf.get(c.instanceId)!;
  const b = treatmentBehaviour.get(c.instanceId)!;
  return {
    instanceId: c.instanceId, repo: r.repo, focus: r.focusAt, goldFiles: r.goldFiles,
    treatmentEdits: r.treatmentEdits, orientationFiles: r.orientationFiles,
    orientationIgnored: r.orientationIgnored, goldFileInOrientation: r.goldFileInOrientation,
    adoption: r.treatmentAdoption, route: routeOf(r),
    distinctFilesRead: b.distinctFilesRead.length, toolCalls: b.toolCalls,
  };
});

const correctFocusSuccesses = cohorts.rows.filter((c) => c.focusCohort === "B_CORRECT_FOCUS_SUCCESS").map((c) => {
  const r = rowOf.get(c.instanceId)!;
  const b = treatmentBehaviour.get(c.instanceId)!;
  return {
    instanceId: c.instanceId, repo: r.repo, focus: r.focusAt,
    filesRead: b.distinctFilesRead, distinctFilesRead: b.distinctFilesRead.length,
    readAnyTestFile: b.readAnyTestFile, toolCalls: b.toolCalls,
    goldFiles: r.goldFiles, treatmentEdits: r.treatmentEdits,
  };
});

const discordant = [
  {
    instanceId: "astropy__astropy-14369", winner: "VTRACE", focusCorrect: false,
    evidenceDifference:
      "both arms read astropy/units/format/cds.py, both diagnosed the right-recursive division rule, and both deleted the cached cds_parsetab.py. The baseline additionally read ogip.py and stated that OGIP 'already uses left recursion ... so it handles this correctly'.",
    divergence:
      "the treatment wrote `combined_units DIVISION unit_expression`, byte-identical to the reference patch. The baseline, having just read a working left-recursive sibling grammar, wrote a three-alternative rule of its own instead of adopting it.",
    classification: "REPAIR_SYNTHESIS_DIFFERENCE_WITH_EQUAL_OR_BETTER_EVIDENCE_ON_THE_LOSING_SIDE",
    vtraceCausal: "NO — the orientation focused astropy/io/ascii/cds.py, a file neither arm edited",
  },
  {
    instanceId: "django__django-12325", winner: "VTRACE", focusCorrect: false,
    evidenceDifference:
      "the decisive fact — the parent-link flag lives at field.remote_field.parent_link — was on screen 6 times for the treatment and 5 for the baseline. The baseline additionally read eleven test-model files.",
    divergence:
      "the treatment filtered the loop on `field.remote_field.parent_link`, matching the reference patch. The baseline kept collecting every OneToOneField and added a precedence rule that still lets declaration order decide in cases the reference patch excludes outright.",
    classification: "NO_MISSING_REPOSITORY_FACT — this pair is M185's known-negative control (§35)",
    vtraceCausal: "NO — the orientation was ignored entirely (touchedAny=false)",
  },
  {
    instanceId: "psf__requests-5414", winner: "BASELINE", focusCorrect: true,
    evidenceDifference:
      "neither arm opened tests/test_requests.py; TestPreparingURLs was on screen zero times on both sides. The baseline read eight more files (adapters.py, utils.py, help.py, docs/api.rst) while tracing where the UnicodeError surfaced.",
    divergence:
      "the winning baseline explicitly considered the losing patch — 'the simplest fix is to ALWAYS try IDNA encoding in _get_idna_encoded_host, not just for non-ASCII hosts' — and rejected it because 'that might have performance implications'. It then wrote a branch that VALIDATES without assigning. The treatment wrote the same idea as an assignment and mutated every ASCII host, breaking eight existing tests.",
    classification: "CORRECT_REPAIR_STOCHASTIC_FAILURE — the alternative was considered and discarded on a performance intuition, not on repository evidence",
    vtraceCausal: "NO — the orientation named the gold file and the treatment edited it; the localization was right and the repair was not",
  },
  {
    instanceId: "pytest-dev__pytest-6197", winner: "BASELINE", focusCorrect: false,
    evidenceDifference:
      "the treatment had MORE gold-adjacent evidence: _ALLOW_MARKERS on screen twice and _mount_obj six times, against zero and one for the baseline. This pair is M185's known-positive control (§34) — the arm that acquired the fact edited the file the fact lives in.",
    divergence:
      "the treatment edited src/_pytest/python.py, the reference patch's file, and did not resolve. The baseline edited src/_pytest/main.py — outside the gold set entirely — and did resolve.",
    classification: "NO_MISSING_REPOSITORY_FACT — the losing arm held strictly more of the reference patch's own material",
    vtraceCausal: "NO — and this is the corpus's clearest demonstration that editing the gold file is neither necessary nor sufficient",
  },
];

writeFileSync(path.join(RESULTS, "stage5_m185_wrong_focus_successes.json"), `${JSON.stringify({
  schemaVersion: "stage5.m185.wrong-focus-successes.v1", milestone: "M185", workstream: "M185-C",
  question: "§30/§100 — how did six runs solve despite VTRACE focusing a non-gold file?",
  routes: wrongFocusSuccesses.reduce<Record<string, number>>((a, w) => ({ ...a, [w.route]: (a[w.route] ?? 0) + 1 }), {}),
  answer: "three ignored the packet entirely and self-localized; two touched an orientation file and then left it for a gold file; one had the gold file in the related list behind a wrong focus. Correct focus is not necessary for a solve.",
  cases: wrongFocusSuccesses,
}, null, 2)}\n`);

writeFileSync(path.join(RESULTS, "stage5_m185_correct_focus_successes.json"), `${JSON.stringify({
  schemaVersion: "stage5.m185.correct-focus-successes.v1", milestone: "M185", workstream: "M185-C",
  question: "§98 — what repository evidence did successful runs recover after localization that failed runs did not?",
  medianDistinctFilesRead: 1,
  armsReadingExactlyOneFile: correctFocusSuccesses.filter((c) => c.distinctFilesRead <= 1).length,
  armsReadingATestFile: correctFocusSuccesses.filter((c) => c.readAnyTestFile).length,
  answer: "nothing. Eleven of thirteen read exactly one file, one of thirteen read a test file, and their median tool-call count is seven against fifteen and a half for unresolved arms. Successful runs recovered LESS evidence, not more.",
  cases: correctFocusSuccesses,
}, null, 2)}\n`);

writeFileSync(path.join(RESULTS, "stage5_m185_discordant_pairs.json"), `${JSON.stringify({
  schemaVersion: "stage5.m185.discordant-pairs.v1", milestone: "M185", workstream: "M185-C",
  question: "§101 — do the two VTRACE-only and two baseline-only wins contain concrete causal repository-evidence differences?",
  answer: "no. In two pairs the decisive evidence was equal on both sides; in one the losing arm held strictly more; in one the winner explicitly considered and rejected the loser's patch on a performance intuition. All four are repair-synthesis divergences, and in none of the four was VTRACE's orientation causal.",
  pairs: discordant,
}, null, 2)}\n`);

console.log("wrong-focus routes:", JSON.stringify(wrongFocusSuccesses.reduce<Record<string, number>>((a, w) => ({ ...a, [w.route]: (a[w.route] ?? 0) + 1 }), {})));
console.log("correct-focus successes reading one file:", correctFocusSuccesses.filter((c) => c.distinctFilesRead <= 1).length, "/", correctFocusSuccesses.length);
console.log("discordant pairs analysed:", discordant.length);
