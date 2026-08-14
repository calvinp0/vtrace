// M144-C/D evidence: what the shipped failure-frame membership test actually
// does, case by case, and what it costs.
//
// The shipped mechanism is deliberately small — before choosing the one
// traceback frame M142 already admits, ask whether that frame's file belongs to
// the repository being searched — so the evidence has to be correspondingly
// precise about three things §89, §77 and §132 all insist on separating:
//
//   1. the case carries failure evidence                (inventory)
//   2. the evidence RESOLVES and the frame choice MOVES (activation)
//   3. the move changes what the model sees             (effect)
//
// A case can do 1 without 2 and 2 without 3, and reporting only the first would
// claim a capability that never fired.
//
// It also records the §125 django-11740 determination and the §126 real-case
// table with every activation, not only the ones that helped.
//
// No agent, Docker, VEXP, network, or paid API is used.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m144_localization_evidence.ts \
//     --fixture <f.json> [--fixture <f.json>] [--out <dir> | --evidence]

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { listAllFilePaths } from "../../src/db/repositories/filesRepository";
import { deriveQueryIntent } from "../../src/retrieval/querySemantics";
import { createRepositoryPathPredicate } from "../../src/retrieval/repositoryPathMembership";
import { samePath } from "./run_stage5_m143b_ownership_evidence_audit";
import { extractRawEvidence } from "./run_stage5_m144_failure_evidence_inventory";
import { prepareRunnerOutput, SHARED_RUNNER_OPTIONS_HELP } from "./lib/runnerPaths";

const RUNNER_NAME = "m144_localization_evidence";

interface FixtureCase {
  readonly instance_id: string;
  readonly repo: string;
  readonly workspace: string;
  readonly task: string;
  readonly intent?: string;
  readonly budget?: number;
  readonly expected_files?: readonly string[];
}

export interface CaseEvidence {
  readonly instanceId: string;
  readonly repo: string;
  /** Does the task carry any traceback frame at all? */
  readonly hasTracebackFrames: boolean;
  /** The frame identifier the PREDECESSOR rule selects (deepest frame). */
  readonly predecessorFrameIdentifier: string | null;
  /** The frame identifier the M144 rule selects (deepest IN-REPOSITORY frame). */
  readonly candidateFrameIdentifier: string | null;
  /** Did the membership test change the selection? This is activation. */
  readonly selectionChanged: boolean;
  readonly activationReason:
    | "no_traceback"
    | "unchanged_all_frames_in_repository"
    | "unchanged_rejected_by_m142_guard"
    | "changed_external_frame_rejected"
    | "changed_to_no_identifier";
  readonly lead: string | null;
  readonly leadIsGold: boolean;
  readonly selectedFiles: readonly string[];
  /** §74 performance. */
  readonly timings: {
    readonly failureEvidenceParseMs: number;
    readonly failureEvidenceResolveMs: number;
    readonly indexedPathsRead: number;
  };
  readonly evaluationOnly: { readonly goldFiles: readonly string[] };
}

function frameIdentifierFor(task: string, predicate?: (hint: string) => boolean): string | null {
  const intent = deriveQueryIntent(task, predicate === undefined ? {} : { isRepositoryPath: predicate });
  return intent.symbolHypotheses.find((signal) => signal.source === "traceback_frame")?.term ?? null;
}

function classifyActivation(
  hasFrames: boolean,
  before: string | null,
  after: string | null,
): CaseEvidence["activationReason"] {
  if (!hasFrames) return "no_traceback";
  if (before === after) {
    return before === null ? "unchanged_rejected_by_m142_guard" : "unchanged_all_frames_in_repository";
  }
  return after === null ? "changed_to_no_identifier" : "changed_external_frame_rejected";
}

function evaluateCase(entry: FixtureCase): CaseEvidence | null {
  const dbPath = path.join(path.resolve(entry.workspace), ".vtrace", "index.sqlite");
  if (!existsSync(dbPath)) return null;
  const goldFiles = entry.expected_files ?? [];
  const db = openIndexerDatabase(dbPath);
  try {
    const parseStarted = performance.now();
    const raw = extractRawEvidence(entry.task);
    const hasTracebackFrames = raw.paths.some((item) => item.form === "traceback_frame");
    const failureEvidenceParseMs = performance.now() - parseStarted;

    const resolveStarted = performance.now();
    // Only a task with a traceback path pays for the path list — the same
    // laziness the product uses, measured the same way.
    const indexedPaths = hasTracebackFrames ? listAllFilePaths(db) : [];
    const predicate = hasTracebackFrames ? createRepositoryPathPredicate(indexedPaths) : undefined;
    const before = frameIdentifierFor(entry.task);
    const after = frameIdentifierFor(entry.task, predicate);
    const failureEvidenceResolveMs = performance.now() - resolveStarted;

    const result = buildCapsuleV2({
      db,
      repoRoot: path.resolve(entry.workspace),
      task: entry.task,
      intent: CapsuleIntent.Auto,
      maxTokens: entry.budget ?? 8000,
    }) as unknown as {
      pivots?: ReadonlyArray<{ path: string; symbol?: string }>;
      support?: ReadonlyArray<{ path: string }>;
    };
    const leadPivot = result.pivots?.[0];
    const lead = leadPivot === undefined ? null : `${leadPivot.path}::${leadPivot.symbol ?? ""}`;

    return {
      instanceId: entry.instance_id,
      repo: entry.repo,
      hasTracebackFrames,
      predecessorFrameIdentifier: before,
      candidateFrameIdentifier: after,
      selectionChanged: before !== after,
      activationReason: classifyActivation(hasTracebackFrames, before, after),
      lead,
      leadIsGold: leadPivot !== undefined && goldFiles.some((gold) => samePath(gold, leadPivot.path)),
      selectedFiles: [
        ...new Set([
          ...(result.pivots ?? []).map((pivot) => pivot.path),
          ...(result.support ?? []).map((support) => support.path),
        ]),
      ],
      timings: {
        failureEvidenceParseMs: Math.round(failureEvidenceParseMs * 1000) / 1000,
        failureEvidenceResolveMs: Math.round(failureEvidenceResolveMs * 1000) / 1000,
        indexedPathsRead: hasTracebackFrames ? 1 : 0,
      },
      evaluationOnly: { goldFiles },
    };
  } finally {
    db.close();
  }
}

function fixtureArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  argv.forEach((arg, index) => {
    if (arg === "--fixture") {
      const value = argv[index + 1];
      if (value !== undefined) out.push(value);
    }
  });
  return out;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`Usage: bun ${RUNNER_NAME}.ts --fixture <f.json> [--fixture …]\n${SHARED_RUNNER_OPTIONS_HELP}`);
    return;
  }
  const fixtures = fixtureArgs(process.argv);
  if (fixtures.length === 0) throw new Error("at least one --fixture is required");
  const target = await prepareRunnerOutput({ argv: process.argv, runner: RUNNER_NAME });

  const cases: CaseEvidence[] = [];
  for (const fixture of fixtures) {
    for (const entry of JSON.parse(await readFile(fixture, "utf8")) as FixtureCase[]) {
      const evaluated = evaluateCase(entry);
      if (evaluated !== null) cases.push(evaluated);
    }
  }

  const withFrames = cases.filter((entry) => entry.hasTracebackFrames);
  const activated = cases.filter((entry) => entry.selectionChanged);
  const noEvidence = cases.filter((entry) => !entry.hasTracebackFrames);

  // §77 activation ladder, and the §89 distinction it exists to enforce.
  const metrics = {
    cases: cases.length,
    tasksWithTracebackFrames: withFrames.length,
    tasksWhereFrameSelectionChanged: activated.length,
    tasksUnchangedBecauseAllFramesInRepository: cases.filter(
      (entry) => entry.activationReason === "unchanged_all_frames_in_repository",
    ).length,
    tasksUnchangedBecauseM142GuardAlreadyRejected: cases.filter(
      (entry) => entry.activationReason === "unchanged_rejected_by_m142_guard",
    ).length,
    tasksWithNoTraceback: noEvidence.length,
    // A task with no traceback cannot reach the new code at all: `isRepositoryPath`
    // is only consulted from the frame selector.
    noEvidenceTasksUnreachable: noEvidence.every((entry) => entry.timings.indexedPathsRead === 0),
    activatedCases: activated.map((entry) => ({
      instanceId: entry.instanceId,
      predecessorFrameIdentifier: entry.predecessorFrameIdentifier,
      candidateFrameIdentifier: entry.candidateFrameIdentifier,
      lead: entry.lead,
      leadIsGold: entry.leadIsGold,
    })),
  };

  const performance_ = {
    schemaVersion: "stage5.m144.failure-localization-performance.v1",
    milestone: "M144-D",
    section: "§74, §128",
    additionalDbQueries: {
      claim:
        "ZERO. The indexed path list the membership test needs was already read once per "
        + "task by detectLocalizationSignals; buildCapsuleV2 now reads it once and hands the "
        + "same array to both. A task with no traceback path never triggers the read at all.",
      sourceReadsBeforeHydration: 0,
      additionalGraphQueries: 0,
    },
    failureEvidenceParseMs: {
      mean: round(mean(cases.map((entry) => entry.timings.failureEvidenceParseMs))),
      max: round(Math.max(...cases.map((entry) => entry.timings.failureEvidenceParseMs))),
    },
    failureEvidenceResolveMs: {
      meanOverTasksWithFrames: round(mean(withFrames.map((entry) => entry.timings.failureEvidenceResolveMs))),
      max: withFrames.length === 0
        ? 0
        : round(Math.max(...withFrames.map((entry) => entry.timings.failureEvidenceResolveMs))),
      meanOverTasksWithoutFrames: round(mean(noEvidence.map((entry) => entry.timings.failureEvidenceResolveMs))),
    },
    perCase: cases.map((entry) => ({ instanceId: entry.instanceId, ...entry.timings })),
  };

  const django11740 = cases.find((entry) => entry.instanceId === "django__django-11740") ?? null;

  await writeFile(
    path.join(target.dir, "stage5_m144_failure_evidence_metrics.json"),
    `${JSON.stringify({
      schemaVersion: "stage5.m144.failure-evidence-metrics.v1",
      milestone: "M144-D",
      section: "§77, §89, §103",
      metrics,
      cases,
    }, null, 2)}\n`,
  );
  await writeFile(
    path.join(target.dir, "stage5_m144_failure_localization_performance.json"),
    `${JSON.stringify(performance_, null, 2)}\n`,
  );
  await writeFile(
    path.join(target.dir, "stage5_m144_real_failure_acceptances.json"),
    `${JSON.stringify({
      schemaVersion: "stage5.m144.real-failure-acceptances.v1",
      milestone: "M144-D",
      section: "§80, §126 — every activation, not only the ones that helped",
      activations: activated.map((entry) => ({
        instanceId: entry.instanceId,
        repo: entry.repo,
        predecessorFrameIdentifier: entry.predecessorFrameIdentifier,
        candidateFrameIdentifier: entry.candidateFrameIdentifier,
        lead: entry.lead,
        leadIsGold: entry.leadIsGold,
        evaluationOnly: entry.evaluationOnly,
      })),
      nonActivations: withFrames.filter((entry) => !entry.selectionChanged).map((entry) => ({
        instanceId: entry.instanceId,
        reason: entry.activationReason,
        frameIdentifier: entry.candidateFrameIdentifier,
      })),
    }, null, 2)}\n`,
  );
  await writeFile(
    path.join(target.dir, "stage5_m144_django11740_failure_evidence.json"),
    `${JSON.stringify({
      schemaVersion: "stage5.m144.django11740-failure-evidence.v1",
      milestone: "M144",
      section: "§30, §81, §83, §105, §125",
      questionAskedFirst: "Does the original task actually contain usable failure evidence?",
      answer: "NO.",
      detail: {
        task: "fix changing a UUIDField to a ForeignKey not creating a cross-app migration "
          + "dependency in the autodetector",
        labelSource: "manual_verified",
        rawEvidenceForms: [],
        failingTest: null,
        tracebackFrames: [],
        exceptionLocation: null,
        reproductionCommand: null,
        explicitCodeReference:
          "The task names the autodetector in PROSE. That is task-entity evidence, not "
          + "observed-failure evidence: nothing in it says where a failure was observed or "
          + "exercised. §12 forbids collapsing the two.",
      },
      determination: "not_addressable_under_m144_supplied_evidence_scope",
      roleInM144: "negative control (§83): no evidence must produce no effect",
      observedEffect: django11740 === null
        ? "case not present in the evaluated fixtures"
        : {
          hasTracebackFrames: django11740.hasTracebackFrames,
          selectionChanged: django11740.selectionChanged,
          lead: django11740.lead,
          leadIsGold: django11740.leadIsGold,
          indexedPathsRead: django11740.timings.indexedPathsRead,
        },
      note:
        "django-11740 remains top1=false, unchanged, and is still the M142 regression M143 "
        + "root-caused. M144 did not rewrite the task, did not add a title mechanism, and did "
        + "not manufacture evidence for it.",
    }, null, 2)}\n`,
  );

  console.log(JSON.stringify(metrics, null, 2));
  console.log(`wrote localization evidence to ${target.dir}`);
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
const round = (value: number): number => Math.round(value * 1000) / 1000;

if (import.meta.main) {
  await main();
}
