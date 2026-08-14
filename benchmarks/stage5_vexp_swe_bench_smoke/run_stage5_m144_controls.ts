// M144 §87 generic control matrix.
//
// The controls run against the pure frame selector with a SYNTHETIC indexed path
// list, so each one states a rule rather than a repository: "a frame in the
// standard library is not this project's code" is true of every project, and a
// control that can only be written against django or requests is testing a
// corpus, not a capability.
//
// The matrix deliberately includes controls for mechanisms M144 did NOT ship.
// §87 lists thirteen fixtures; the milestone shipped one narrow rule, and the
// honest way to report that is to say which controls the shipped rule answers,
// which were MEASURED and left unshipped with the measurement attached, and which
// are out of scope because the evidence class they need is absent from the corpus.
// Silently omitting them would read as coverage.
//
// No agent, Docker, VEXP, network, or paid API is used.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m144_controls.ts [--out <dir>|--evidence]

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { deriveQueryIntent } from "../../src/retrieval/querySemantics";
import { createRepositoryPathPredicate } from "../../src/retrieval/repositoryPathMembership";
import { extractRawEvidence } from "./run_stage5_m144_failure_evidence_inventory";
import { prepareRunnerOutput, SHARED_RUNNER_OPTIONS_HELP } from "./lib/runnerPaths";

const RUNNER_NAME = "m144_controls";

type ControlStatus = "pass" | "fail";

interface FrameControl {
  readonly id: string;
  readonly section: string;
  readonly intent: string;
  readonly task: string;
  readonly indexedPaths: readonly string[];
  /** What the PREDECESSOR rule selects (no repository knowledge). */
  readonly expectedWithoutIndex: string | null;
  /** What the M144 rule selects. */
  readonly expectedWithIndex: string | null;
}

function frameIdentifier(task: string, indexedPaths?: readonly string[]): string | null {
  const intent = deriveQueryIntent(
    task,
    indexedPaths === undefined ? {} : { isRepositoryPath: createRepositoryPathPredicate(indexedPaths) },
  );
  return intent.symbolHypotheses.find((signal) => signal.source === "traceback_frame")?.term ?? null;
}

const RAISED = "ValueError: bad thing";

const FRAME_CONTROLS: readonly FrameControl[] = [
  {
    id: "raising_production_frame",
    section: "§52",
    intent: "A raising frame inside the repository is strong corroboration and stays selected.",
    task: `File "/srv/proj/pkg/widget.py", line 12, in compute_widget\n${RAISED}`,
    indexedPaths: ["pkg/widget.py"],
    expectedWithoutIndex: "compute_widget",
    expectedWithIndex: "compute_widget",
  },
  {
    id: "framework_traceback_frame",
    section: "§51",
    intent: "A frame in framework/library code must not name the failure site.",
    task: `File "/srv/proj/pkg/widget.py", line 12, in compute_widget | `
      + `File "/usr/lib/python3.11/json/decoder.py", line 355, in raw_decode | ${RAISED}`,
    indexedPaths: ["pkg/widget.py"],
    expectedWithoutIndex: "raw_decode",
    expectedWithIndex: "compute_widget",
  },
  {
    id: "installed_copy_of_own_code",
    section: "§24",
    intent: "An installed copy of the project's own code IS repository code.",
    task: `File "/venv/lib/python3.11/site-packages/proj/pkg/widget.py", line 12, in compute_widget\n${RAISED}`,
    indexedPaths: ["pkg/widget.py"],
    expectedWithoutIndex: "compute_widget",
    expectedWithIndex: "compute_widget",
  },
  {
    id: "foreign_dependency_at_same_prefix",
    section: "§24, §67",
    intent: "A genuinely foreign dependency under the same prefix is still foreign.",
    task: `File "/venv/lib/python3.11/site-packages/other/vendor.py", line 3, in vendor_call\n${RAISED}`,
    indexedPaths: ["pkg/widget.py"],
    expectedWithoutIndex: "vendor_call",
    expectedWithIndex: null,
  },
  {
    id: "symptom_site_vs_controlling_caller",
    section: "§53",
    intent:
      "The deepest in-repository frame can be a generic accessor while the behaviour is the "
      + "caller's. The M142 dunder guard must survive repository filtering.",
    task: `File "/srv/proj/pkg/dataset.py", line 90, in merge | `
      + `File "/srv/proj/pkg/common.py", line 233, in __getattr__ | `
      + "AttributeError: no attribute 'items'",
    indexedPaths: ["pkg/dataset.py", "pkg/common.py"],
    expectedWithoutIndex: null,
    expectedWithIndex: null,
  },
  {
    id: "unresolved_path_stays_unknown",
    section: "§25, §67",
    intent: "Every frame outside the repository yields no identifier, not a fallback to the deepest.",
    task: `File "/usr/lib/python3.11/re/_compiler.py", line 764, in compile | `
      + `File "/usr/lib/python3.11/re/_parser.py", line 838, in _parse | ${RAISED}`,
    indexedPaths: ["pkg/widget.py"],
    expectedWithoutIndex: "_parse",
    expectedWithIndex: null,
  },
  {
    id: "truncated_traceback_abstains",
    section: "§13, §70",
    intent: "A stack cut before the exception names no site, whichever frame filtering would pick.",
    task: `File "/srv/proj/pkg/widget.py", line 12, in compute_widget | `
      + `File "/usr/lib/python3.11/re/_parser.py", line 838, in _parse`,
    indexedPaths: ["pkg/widget.py"],
    expectedWithoutIndex: null,
    expectedWithIndex: null,
  },
  {
    id: "duplicate_evidence_does_not_multiply",
    section: "§69",
    intent: "The same frame repeated stays ONE selection; authority cannot be multiplied by repetition.",
    task: `File "/srv/proj/pkg/widget.py", line 12, in compute_widget | `
      + `File "/srv/proj/pkg/widget.py", line 12, in compute_widget | `
      + `File "/srv/proj/pkg/widget.py", line 40, in compute_widget | ${RAISED}`,
    indexedPaths: ["pkg/widget.py"],
    expectedWithoutIndex: "compute_widget",
    expectedWithIndex: "compute_widget",
  },
  {
    id: "conflicting_anchors_pick_the_repository_one",
    section: "§70",
    intent:
      "When frames disagree about whose code ran last, membership — not depth — decides, and "
      + "the deepest frame this repository owns is the answer.",
    task: `File "/home/reporter/scratch.py", line 1, in <module> | `
      + `File "/srv/proj/pkg/alpha.py", line 5, in alpha_step | `
      + `File "/srv/proj/pkg/beta.py", line 9, in beta_step | `
      + `File "/usr/lib/python3.11/socket.py", line 700, in sendall | ${RAISED}`,
    indexedPaths: ["pkg/alpha.py", "pkg/beta.py"],
    expectedWithoutIndex: "sendall",
    expectedWithIndex: "beta_step",
  },
  {
    id: "no_failure_evidence_no_effect",
    section: "§62, §63",
    intent: "A task with no traceback yields no frame identifier with or without an index.",
    task: "the widget renders the wrong label when the locale is unset",
    indexedPaths: ["pkg/widget.py"],
    expectedWithoutIndex: null,
    expectedWithIndex: null,
  },
  {
    id: "bare_tail_frame_not_filtered_on_absence",
    section: "§20, §22",
    intent: "A frame with no path carries no membership evidence and must not be rejected for that.",
    task: `line 45, in render_template\n${RAISED}`,
    indexedPaths: ["pkg/views.py"],
    expectedWithoutIndex: "render_template",
    expectedWithIndex: "render_template",
  },
];

/** §64: prose containing the WORDS must not manufacture failure evidence. */
const PROSE_FALSE_POSITIVE_CONTROLS: readonly string[] = [
  "tests show this is slow",
  "this error is conceptual",
  "see file format documentation",
  "the stack implementation is generic",
  "traceback support was added recently",
  "pytest versions: 5.4.x, current master",
  "the file handling in this module is confusing",
  "an exception to the rule is documented above",
];

/**
 * §87 controls whose MECHANISM M144 did not ship. Each carries the measurement
 * that decided it, so "not shipped" is a result rather than an omission.
 */
const UNSHIPPED_CONTROLS = [
  {
    id: "failing_test_to_direct_production_call",
    section: "§48",
    mechanism: "failing test symbol -> direct calls -> production owner",
    status: "measured_not_shipped",
    measurement:
      "All 6 failing-test mentions in the frozen 50 are BARE names (`test_app`, `test_foo`, "
      + "`test_f_true`, `test_requests`, `test_skip_location`, `test_it`, `test_arit`, `test_Mod`); "
      + "the corpus contains ZERO pytest node ids. Only 3 of the 6 cases resolve any symbol of that "
      + "name, and django-12273's `test_f_true` does not exist in the repository at all. A lane "
      + "keyed on a bare test name would be resolving a string that names nothing.",
  },
  {
    id: "broad_module_import_negative",
    section: "§49",
    mechanism: "test imports a package but exercises unrelated behaviour",
    status: "not_applicable_no_shipped_lane",
    measurement:
      "No test-to-production relation lane was shipped, so there is no import-derived ownership "
      + "claim to control. Recorded rather than dropped: the control becomes required the moment "
      + "such a lane exists.",
  },
  {
    id: "test_helper_second_hop",
    section: "§50",
    mechanism: "failing test -> helper -> production",
    status: "not_applicable_no_shipped_lane",
    measurement: "Same reason as the broad-import control.",
  },
  {
    id: "direct_relation_from_frame_to_owner",
    section: "§29, §45",
    mechanism: "deepest in-repository frame -> direct calls -> behaviour owner",
    status: "measured_not_shipped",
    measurement:
      "REAL and reachable: pylint-8898's gold (`pylint/utils/utils.py`) is reached by direct "
      + "`calls` edges from the deepest in-repository frame `_config_initialization`, and it is the "
      + "ONE frozen-50 case where no frame is itself gold. It was not shipped for two measured "
      + "reasons. (1) Its traceback is truncated — no exception line — so using it requires "
      + "relaxing the M142 completeness guard that M142 measured as harmful. (2) The case already "
      + "has gold ANYWHERE; only the lead is wrong, so the lane would have to carry ranking "
      + "authority, which is exactly the §43 architecture M143 condemned in the title lane. "
      + "Direct-relation precision across all six traceback cases is recorded in "
      + "stage5_m144_traceback_attribution.json.",
  },
  {
    id: "reproduction_command_attribution",
    section: "§39, §123",
    mechanism: "reproduction command -> test target -> subsystem",
    status: "not_justified_evidence_absent",
    measurement:
      "The frozen 50 contains ONE genuine reproduction command (`manage.py migrate`, django-13112), "
      + "which names a management command rather than a test target, and one near-miss the typed "
      + "shape correctly rejects (`pytest versions: 5.4.x` in pytest-7432 is prose). §123 makes the "
      + "artifact conditional on the evidence existing; it does not.",
  },
  {
    id: "explicit_source_path_positive",
    section: "§54, §89",
    mechanism: "task names a source path directly",
    status: "already_solved_organically",
    measurement:
      "psf-5414's GitHub blob anchor (`.../requests/models.py#L401`) already reaches gold top-1 "
      + "through M103 anchor preservation plus ordinary path retrieval. §89 forbids counting it as "
      + "an M144 gain.",
  },
  {
    id: "title_subject_is_or_is_not_owner",
    section: "§60, §106",
    mechanism: "failure evidence vs title evidence",
    status: "no_interaction_possible",
    measurement:
      "The five title-injection cases (django-11740, django-13112, django-11133, django-12276, "
      + "sympy-16766) carry no traceback frame, so the shipped rule is unreachable on all of them. "
      + "Verified per case in stage5_m144_failure_evidence_metrics.json.",
  },
] as const;

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`Usage: bun ${RUNNER_NAME}.ts\n${SHARED_RUNNER_OPTIONS_HELP}`);
    return;
  }
  const target = await prepareRunnerOutput({ argv: process.argv, runner: RUNNER_NAME });

  const frameResults = FRAME_CONTROLS.map((control) => {
    const withoutIndex = frameIdentifier(control.task);
    const withIndex = frameIdentifier(control.task, control.indexedPaths);
    const status: ControlStatus =
      withoutIndex === control.expectedWithoutIndex && withIndex === control.expectedWithIndex ? "pass" : "fail";
    return {
      id: control.id,
      section: control.section,
      intent: control.intent,
      predecessorSelection: withoutIndex,
      candidateSelection: withIndex,
      expectedPredecessorSelection: control.expectedWithoutIndex,
      expectedCandidateSelection: control.expectedWithIndex,
      /** §88: does this control DISCRIMINATE the predecessor from the candidate? */
      discriminating: control.expectedWithoutIndex !== control.expectedWithIndex,
      status,
    };
  });

  const proseResults = PROSE_FALSE_POSITIVE_CONTROLS.map((prose) => {
    const raw = extractRawEvidence(prose);
    const frame = frameIdentifier(prose, ["pkg/widget.py", "stack.py", "tests.md"]);
    const status: ControlStatus =
      raw.paths.length === 0 && raw.reproductionCommands.length === 0 && frame === null ? "pass" : "fail";
    return {
      prose,
      extractedPaths: raw.paths.map((item) => item.raw),
      extractedReproductionCommands: raw.reproductionCommands,
      frameIdentifier: frame,
      status,
    };
  });

  const failures = [...frameResults, ...proseResults].filter((entry) => entry.status === "fail");

  const artifact = {
    schemaVersion: "stage5.m144.failure-localization-generic-controls.v1",
    milestone: "M144-C",
    section: "§64, §87, §88, §94",
    method:
      "Synthetic indexed path lists against the pure frame selector: every control states a rule "
      + "that holds for any repository, not a fact about one corpus.",
    summary: {
      frameControls: frameResults.length,
      frameControlsPassing: frameResults.filter((entry) => entry.status === "pass").length,
      discriminatingControls: frameResults.filter((entry) => entry.discriminating).length,
      proseFalsePositiveControls: proseResults.length,
      proseControlsPassing: proseResults.filter((entry) => entry.status === "pass").length,
      allPassing: failures.length === 0,
    },
    frameControls: frameResults,
    proseFalsePositiveControls: proseResults,
    unshippedMechanismControls: UNSHIPPED_CONTROLS,
  };

  await writeFile(
    path.join(target.dir, "stage5_m144_failure_localization_generic_controls.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );

  // §123 parser controls: the typed shapes, and what they must refuse.
  await writeFile(
    path.join(target.dir, "stage5_m144_failure_parser_controls.json"),
    `${JSON.stringify({
      schemaVersion: "stage5.m144.failure-parser-controls.v1",
      milestone: "M144-A",
      section: "§19, §20, §64, §123",
      principle:
        "Text resembling a path is not failure evidence without structural context — the M142 "
        + "lesson (prose != identifier intent) applied to a new evidence class.",
      proseFalsePositiveControls: proseResults,
      allPassing: proseResults.every((entry) => entry.status === "pass"),
    }, null, 2)}\n`,
  );

  console.log(JSON.stringify(artifact.summary, null, 2));
  if (failures.length > 0) {
    console.log("FAILING CONTROLS:", JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  }
  console.log(`wrote controls to ${target.dir}`);
}

if (import.meta.main) {
  await main();
}
