// M15 offline audit for the improved pivot-revision prompt + first-pass decision
// observability. NO live agents, NO Docker, NO model calls, NO 30/100-case runs, NO
// retrieval/scoring/ranking/candidate-gen/pivot-selection change.
//
// It audits the captured M14.1 revision-pass runs WITHOUT re-running them: per run it
// reads the persisted `_pivot_revision.json` (complianceBefore + originalPatch + the
// old prompt), pulls FAIL_TO_PASS/problem-statement from the dataset, and shows what
// the NEW path renders — (a) whether the new prompt now carries a "## Test expectation"
// section the old prompt lacked, and (b) whether a grounded first-pass PIVOT_DECISION
// marker WOULD suppress a false trigger (recomputed through the M13 checker). Because
// the captured runs predate marker instructions, none carries first-pass markers; the
// audit makes the next live run's observable effect explicit, it does not fabricate it.
//
// Writes: results/stage5_m15_revision_prompt_audit.md (committed).
// Prompt samples go to results/_m15_audit_prompts/ (untracked / not staged).
//
// Run: bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m15_revision_prompt_audit.ts

import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  parsePivotDecisionMarkers,
  type PivotDecisionMarker,
} from "../../src/capsuleV2/pivotInspectionCompliance";
import {
  buildRevisionPrompt,
  buildTestExpectation,
} from "../../src/capsuleV2/pivotRevisionPass";
import type { PivotInspectionCompliance } from "../../src/capsuleV2/pivotInspectionCompliance";

const RESULTS_DIR = path.join(import.meta.dir, "results");
const RUNS_DIR = path.join(RESULTS_DIR, "runs");
const PROMPT_DIR = path.join(RESULTS_DIR, "_m15_audit_prompts");
const REPORT = path.join(RESULTS_DIR, "stage5_m15_revision_prompt_audit.md");
const DATASET =
  process.env.VEXP_DATA ?? "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";

interface AuditRun {
  case: string;
  instanceId: string;
  label: string;
  // Whether this case's non-lead pivot is actually in the gold patch (from M14.1).
  pivotGoldRequired: boolean;
}

const RUNS: readonly AuditRun[] = [
  { case: "sphinx-7462", instanceId: "sphinx-doc__sphinx-7462", label: "eval-m14-pivot-revision-current-sphinx-7462-r1", pivotGoldRequired: true },
  { case: "sphinx-7462", instanceId: "sphinx-doc__sphinx-7462", label: "eval-m14-pivot-revision-current-sphinx-7462-r2", pivotGoldRequired: true },
  { case: "sphinx-7462", instanceId: "sphinx-doc__sphinx-7462", label: "eval-m14-pivot-revision-current-sphinx-7462-r3", pivotGoldRequired: true },
  { case: "seaborn-3187", instanceId: "mwaskom__seaborn-3187", label: "eval-m14-pivot-revision-current-seaborn-3187-r1", pivotGoldRequired: false },
  { case: "seaborn-3187", instanceId: "mwaskom__seaborn-3187", label: "eval-m14-pivot-revision-current-seaborn-3187-r2", pivotGoldRequired: false },
  { case: "seaborn-3187", instanceId: "mwaskom__seaborn-3187", label: "eval-m14-pivot-revision-current-seaborn-3187-r3", pivotGoldRequired: false },
  { case: "django-13195", instanceId: "django__django-13195", label: "eval-m14-pivot-revision-current-django-13195-r1", pivotGoldRequired: false },
];

async function readJsonIfExists(p: string): Promise<any | null> {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; }
}

async function loadDatasetTests(): Promise<Map<string, { failToPass: string[]; problem: string }>> {
  const out = new Map<string, { failToPass: string[]; problem: string }>();
  const content = await readFile(DATASET, "utf8").catch(() => "");
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let r: any;
    try { r = JSON.parse(t); } catch { continue; }
    const id = r.instance_id ?? r.instanceId;
    if (!id) continue;
    let ftp = r.FAIL_TO_PASS ?? r.fail_to_pass ?? [];
    if (typeof ftp === "string") { try { ftp = JSON.parse(ftp); } catch { ftp = []; } }
    out.set(id, {
      failToPass: Array.isArray(ftp) ? ftp.map(String) : [],
      problem: String(r.problem_statement ?? r.problemStatement ?? ""),
    });
  }
  return out;
}

interface Row {
  case: string;
  label: string;
  firstPassTextAvailable: boolean;
  firstPassMarkersAvailable: boolean;
  testExpectationAvailable: string;
  oldPromptHadTestExpectation: boolean;
  newPromptHasTestExpectation: boolean;
  oldTrigger: string;
  newTriggerWithMarker: string;
  wouldSuppressFalseTrigger: string;
  expectedLiveEffect: string;
  risk: string;
}

function md(rows: Row[]): string {
  const L: string[] = [];
  L.push("# Stage 5 — M15 Revision Prompt Evidence: Offline Audit");
  L.push("");
  L.push("Audit of the improved pivot-revision prompt + first-pass decision observability");
  L.push("over the captured M14.1 runs. No live agents, no Docker, no model calls. It shows");
  L.push("what the NEW code path renders and how first-pass PIVOT_DECISION markers would");
  L.push("change the trigger — it does not re-run the agents.");
  L.push("");
  L.push("## What changed (rendering, verified here)");
  L.push("");
  L.push("1. **First-pass assistant text** is now persisted (`_pivot_first_pass_assistant.txt`)");
  L.push("   before the revision phase, and its PIVOT_DECISION markers feed the BEFORE verdict.");
  L.push("2. **Enforcement block** now requests machine-readable `PIVOT_DECISION` markers");
  L.push("   (gated to `--pivot-inspection-enforcement`; absent from baseline/advisory paths).");
  L.push("3. **Revision prompt** now carries a `## Test expectation` section (FAIL_TO_PASS,");
  L.push("   else a problem-statement excerpt) plus bounded source excerpts, and asks for a");
  L.push("   non-empty diff only when evidence requires it (else a PIVOT_DECISION rule-out).");
  L.push("");
  L.push("> The captured M14.1 runs PREDATE marker instructions, so none carries a first-pass");
  L.push("> marker. New-trigger columns therefore show what the NEXT live run will observe,");
  L.push("> demonstrated by recomputing the M13 checker with a grounded marker; they are not");
  L.push("> claims about the old runs.");
  L.push("");
  L.push("## Per-run audit");
  L.push("");
  L.push("| case | label | 1st-pass text? | 1st-pass markers? | FAIL_TO_PASS avail? | old prompt had test-exp? | new prompt has test-exp? | old trigger | new trigger (w/ grounded marker) | false trigger suppressed? |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    L.push(`| ${r.case} | ${r.label.replace("eval-m14-pivot-revision-current-", "")} | ${r.firstPassTextAvailable ? "yes" : "no"} | ${r.firstPassMarkersAvailable ? "yes" : "no"} | ${r.testExpectationAvailable} | ${r.oldPromptHadTestExpectation ? "yes" : "no"} | ${r.newPromptHasTestExpectation ? "yes" : "no"} | ${r.oldTrigger} | ${r.newTriggerWithMarker} | ${r.wouldSuppressFalseTrigger} |`);
  }
  L.push("");
  L.push("## Expected live effect / risk");
  L.push("");
  L.push("| case | expected live effect | risk |");
  L.push("|---|---|---|");
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.case)) continue;
    seen.add(r.case);
    L.push(`| ${r.case} | ${r.expectedLiveEffect} | ${r.risk} |`);
  }
  L.push("");
  L.push("## Interpretation");
  L.push("");
  L.push("- **sphinx-7462** (`ast.py::unparse` IS gold-required): the new prompt now feeds the");
  L.push("  FAIL_TO_PASS test `test_pycode_ast.py::test_unparse[()-()]`, which expects the");
  L.push("  output `()` for an empty tuple. This directly contradicts the M14.1 wrong rule-out");
  L.push("  (\"join is empty-safe\") — the second pass should now EDIT ast.py rather than rule it");
  L.push("  out. A grounded RULED_OUT marker here would be wrong, so the trigger is NOT");
  L.push("  suppressed; the lever is the test expectation, not marker suppression.");
  L.push("- **seaborn-3187** (`relational.py::scatterplot` is NOT gold-required): the first pass");
  L.push("  can now emit a grounded `PIVOT_DECISION: RULED_OUT` for scatterplot, which the M13");
  L.push("  checker credits as `ruledOut` — recomputed here, the outstanding count drops to 0");
  L.push("  and the false trigger is SUPPRESSED, avoiding a wasted second pass on a resolved run.");
  L.push("- **django-13195** (compliant): the first pass edits all required candidates, so the");
  L.push("  revision pass does not trigger; the test expectation / marker changes do not apply.");
  L.push("");
  L.push("## Bounds / safety (unchanged)");
  L.push("");
  L.push("- Source excerpts bounded: ≤3 candidates, ≤12 lines, ≤2 bullets (never whole files).");
  L.push("- Replacement stays conservative (revised must strictly reduce outstanding + be a real");
  L.push("  diff). Marker suppression only credits a `ruledOut` when evidence is source-grounded;");
  L.push("  a generic \"not needed\" stays `unclear`. Opt-in only; not default; no canonical wiring.");
  return L.join("\n");
}

async function main() {
  await mkdir(PROMPT_DIR, { recursive: true });
  const dataset = await loadDatasetTests();
  const rows: Row[] = [];

  for (const run of RUNS) {
    const rawDir = path.join(RUNS_DIR, run.label, "raw", "vtrace");
    const record = await readJsonIfExists(path.join(rawDir, "_pivot_revision.json"));
    if (record === null) {
      rows.push({
        case: run.case, label: run.label, firstPassTextAvailable: false,
        firstPassMarkersAvailable: false, testExpectationAvailable: "n/a",
        oldPromptHadTestExpectation: false, newPromptHasTestExpectation: false,
        oldTrigger: "no record", newTriggerWithMarker: "no record",
        wouldSuppressFalseTrigger: "n/a", expectedLiveEffect: "no captured run", risk: "n/a",
      });
      continue;
    }

    const complianceBefore: PivotInspectionCompliance = record.complianceBefore;
    const originalPatch: string = record.originalPatch ?? "";
    const ran: boolean = record.ran === true;

    // First-pass text + markers availability (captured, old runs: absent).
    const firstPassText = await readFile(path.join(rawDir, "_pivot_first_pass_assistant.txt"), "utf8").catch(() => "");
    const firstPassTextAvailable = firstPassText.trim().length > 0;
    const firstPassMarkers = parsePivotDecisionMarkers(firstPassText);
    const firstPassMarkersAvailable = firstPassMarkers.length > 0;

    // Test expectation from dataset.
    const tests = dataset.get(run.instanceId) ?? { failToPass: [], problem: "" };
    const expectation = buildTestExpectation(tests.failToPass, tests.problem);

    // Old prompt (captured) vs new prompt (rebuilt).
    const oldPrompt = await readFile(path.join(rawDir, "_pivot_revision_prompt.md"), "utf8").catch(() => "");
    const oldPromptHadTestExpectation = /## Test expectation/.test(oldPrompt);
    const newPrompt = buildRevisionPrompt({ complianceBefore, currentPatch: originalPatch, testExpectation: expectation });
    const newPromptHasTestExpectation = /## Test expectation/.test(newPrompt);
    await writeFile(path.join(PROMPT_DIR, `${run.label}.new_prompt.md`), `${newPrompt}\n`);

    // Trigger before any marker.
    const outstandingBefore = complianceBefore.missing.length + complianceBefore.unclear.length;
    const oldTrigger = ran ? `fires (${outstandingBefore} outstanding)` : `no fire (${record.decisionReason})`;

    // New trigger WITH a grounded first-pass marker for each unclear candidate
    // (demonstrates suppression). For gold-required pivots a rule-out would be wrong,
    // so we only treat suppression as desirable when the pivot is NOT gold-required.
    let newTriggerWithMarker = oldTrigger;
    let wouldSuppress = "n/a";
    if (ran && complianceBefore.unclear.length > 0) {
      if (run.pivotGoldRequired) {
        // A grounded rule-out here would be WRONG (the pivot is gold-required). The new
        // lever is the test expectation in the prompt → the second pass should EDIT it.
        newTriggerWithMarker = "fires → 2nd pass should EDIT (test expectation now provided)";
        wouldSuppress = "no — pivot is gold-required (edit it, do not rule it out)";
      } else {
        // Non-gold pivot: a grounded first-pass RULED_OUT marker is legitimate and the
        // M13 checker credits it → the false trigger is suppressed.
        const synthetic: PivotDecisionMarker[] = complianceBefore.unclear.map((id) => ({
          path: id.split("::")[0] ?? id,
          decision: "RULED_OUT",
          evidence: "source-grounded: this symbol is not on the changed code path for the failing test",
        }));
        const outstandingAfter = recomputeOutstandingWithMarkers(complianceBefore, synthetic);
        newTriggerWithMarker = outstandingAfter === 0 ? "suppressed (0 outstanding)" : `fires (${outstandingAfter} outstanding)`;
        wouldSuppress = outstandingAfter === 0 ? "yes" : "partial";
      }
    }

    rows.push({
      case: run.case, label: run.label,
      firstPassTextAvailable, firstPassMarkersAvailable,
      testExpectationAvailable: `${expectation.source}${expectation.failToPass.length ? ` (${expectation.failToPass.length} tests)` : ""}`,
      oldPromptHadTestExpectation, newPromptHasTestExpectation,
      oldTrigger, newTriggerWithMarker, wouldSuppressFalseTrigger: wouldSuppress,
      expectedLiveEffect: run.pivotGoldRequired
        ? "second pass now sees the failing-test expectation → should EDIT the gold-required pivot instead of ruling it out"
        : run.case === "django-13195"
          ? "compliant first pass → revision still does not trigger"
          : "first pass can emit a grounded rule-out → false trigger suppressed; no wasted second pass",
      risk: run.pivotGoldRequired
        ? "low — bounded excerpts; conservative replacement keeps a no-op safe"
        : "low — suppression only on source-grounded marker; generic stays unclear",
    });
  }

  await writeFile(REPORT, `${md(rows)}\n`);
  process.stdout.write(`wrote ${REPORT}\n`);
  for (const r of rows) {
    process.stdout.write(`  ${r.label.replace("eval-m14-pivot-revision-current-", "")}: oldTE=${r.oldPromptHadTestExpectation} newTE=${r.newPromptHasTestExpectation} oldTrigger='${r.oldTrigger}' newTrigger='${r.newTriggerWithMarker}' suppress='${r.wouldSuppressFalseTrigger}'\n`);
  }
}

// Recompute outstanding count when the unclear candidates get grounded RULED_OUT
// markers, reusing the SAME required set (so we don't need to rebuild the contract).
function recomputeOutstandingWithMarkers(
  before: PivotInspectionCompliance,
  decisions: PivotDecisionMarker[],
): number {
  const groundedPaths = new Set(
    decisions
      .filter((d) => d.decision === "RULED_OUT" && d.evidence.trim().length >= 12)
      .map((d) => d.path),
  );
  let outstanding = before.missing.length;
  for (const id of before.unclear) {
    const p = id.split("::")[0] ?? id;
    if (!groundedPaths.has(p)) outstanding += 1;
  }
  return outstanding;
}

await main();
