// M144-A §16 failure-evidence inventory.
//
// WHY THIS RUNS BEFORE ANY PRODUCT CHANGE
// ---------------------------------------
// M144 asks whether task-supplied *observed failure evidence* — a failing test,
// a traceback frame, an exception location, a reproduction command — can localize
// behaviour that static title/entity relationships cannot. §16 and §92 forbid
// building the capability before knowing how often the evidence exists: "Do not
// build a feature before knowing how often the evidence exists", and "if inventory
// shows little/no usable failure evidence in the target benchmark corpus, stop
// before implementing speculative product code."
//
// So this runner counts. It is DELIBERATELY LIBERAL: it reports raw failure-LIKE
// text, which is the denominator §77 needs to separate
//
//     "a parser exists"   (tasks with raw failure-like text)
// from
//     "the capability is useful"   (typed, resolved, and actually moving anything)
//
// A precise typed extractor is Workstream A's product deliverable and is measured
// against these counts, not the other way round.
//
// WHAT IT DOES NOT DO
//   - It never reads the gold patch to decide an evidence class. `expected_files`
//     is carried through for EVALUATION-ONLY reporting (§79) and is clearly
//     labelled as such in every row.
//   - It never resolves against the index. Path *shape* is structural only;
//     real resolution is Workstream B (§93), and the two must not be conflated.
//
// No agent, Docker, VEXP, network, or paid API is used.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m144_failure_evidence_inventory.ts \
//     [--out <dir> | --evidence]

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ARC_BEHAVIORAL_CASES, ARC_EXPLICIT_CONTROLS } from "./run_stage5_m142_behavioral_probe";
import { prepareRunnerOutput, SHARED_RUNNER_OPTIONS_HELP, REPO_ROOT } from "./lib/runnerPaths";

const RUNNER_NAME = "m144_failure_evidence_inventory";

// ---------------------------------------------------------------------------
// The evidence taxonomy being counted
// ---------------------------------------------------------------------------

/**
 * Raw failure-evidence forms. These are the *observable* forms §16 lists; whether
 * a form survives into a typed, trusted signal is a later question.
 *
 * `exception_name` is included because the corpus carries it prominently, but note
 * it is NOT a localization form: an exception class names a symptom, not a place.
 * Counting it separately keeps §11's hierarchy honest — it must never be reported
 * as though it localized anything.
 */
export type RawEvidenceForm =
  | "traceback_frame"
  | "exception_name"
  | "failing_test_name"
  | "pytest_nodeid"
  | "explicit_source_path"
  | "line_anchor"
  | "reproduction_command";

export const RAW_EVIDENCE_FORMS: readonly RawEvidenceForm[] = [
  "traceback_frame",
  "exception_name",
  "failing_test_name",
  "pytest_nodeid",
  "explicit_source_path",
  "line_anchor",
  "reproduction_command",
];

/** Which forms are capable of naming a PLACE. The rest are symptom vocabulary. */
export const LOCALIZING_FORMS: readonly RawEvidenceForm[] = [
  "traceback_frame",
  "failing_test_name",
  "pytest_nodeid",
  "explicit_source_path",
  "line_anchor",
  "reproduction_command",
];

/**
 * Structural shape of a path mentioned by the task, decided WITHOUT the index.
 *
 * This is a hint, never a verdict. `site_packages` matters because the corpus is
 * full of frames like `/app/venv/.../site-packages/django/db/models/query.py` —
 * a path marked "external" by its prefix that names the project's OWN source and
 * resolves cleanly inside the repository. Only Workstream B's resolution can tell
 * those apart, so this field exists to be *compared against* that resolution.
 */
export type PathShape =
  | "repo_relative"
  | "site_packages"
  | "stdlib"
  | "absolute_foreign"
  | "interpreter_pseudo"
  | "url";

export interface ExtractedPath {
  readonly raw: string;
  /** Backslashes normalized, `./` prefix dropped — the form a resolver would see. */
  readonly normalized: string;
  readonly shape: PathShape;
  readonly form: RawEvidenceForm;
  /** Traceback frames only: the enclosing function the frame named. */
  readonly frameSymbol?: string;
  /** Traceback frames only: 1-based index in the frame sequence. */
  readonly frameIndex?: number;
  /** Traceback frames only: true for the LAST frame (the raising site). */
  readonly raisingFrame?: boolean;
}

export interface CaseInventory {
  readonly instanceId: string;
  readonly suite: string;
  readonly repo: string;
  readonly labelSource: string;
  readonly taskChars: number;
  readonly forms: readonly RawEvidenceForm[];
  readonly hasAnyEvidence: boolean;
  readonly hasLocalizingEvidence: boolean;
  readonly exceptionNames: readonly string[];
  readonly failingTestNames: readonly string[];
  readonly reproductionCommands: readonly string[];
  readonly paths: readonly ExtractedPath[];
  /** EVALUATION ONLY (§79). Never an input to any classification above. */
  readonly evaluationOnly: {
    readonly goldFiles: readonly string[];
    /** Does any extracted path suffix-match a gold file? Diagnostic only. */
    readonly anyPathMatchesGold: boolean;
    readonly goldMatchingPaths: readonly string[];
  };
}

// ---------------------------------------------------------------------------
// Extraction (audit-side, liberal by design)
// ---------------------------------------------------------------------------

// `File "<path>", line N[, in symbol]`. The path may be POSIX, Windows
// (`\path\to\...` — sphinx-7462 in the corpus), or an interpreter pseudo-file
// (`<stdin>`, `<console>`). The symbol may be `<module>`.
const TRACEBACK_FRAME_RE = /File ["']([^"'\n]+)["'],\s*line\s+(\d+)(?:,\s*in\s+([\w<>]+))?/g;

// CamelCase identifiers ending Error/Exception/Warning. Same shape the M103 task
// derivation uses, so the inventory counts what the derivation actually emitted.
const EXCEPTION_RE = /\b[A-Z][A-Za-z0-9]*(?:Error|Exception|Warning)\b/g;

// pytest node ids. Measured at ZERO in the current corpus — kept in the taxonomy
// so the inventory can state that absence as a measurement rather than an omission.
const NODEID_RE = /\b[\w./-]+\.py::[\w:.[\]-]+/g;

// Bare `test_*` names. Deliberately liberal: `test_foo` / `test_app` are exactly
// the weak evidence the milestone needs measured, not assumed away.
const BARE_TEST_RE = /\btest_[a-zA-Z0-9_]{2,}\b/g;

// A source-file mention in prose: something ending in a source extension. Bare
// basenames (`mwe.py`) are included; deciding they mean nothing is resolution's job.
const SOURCE_PATH_RE = /(?:[\w.-]+[\\/])*[\w.-]+\.(?:py|pyx|pxd|pyi)\b/g;

// Editor / blob anchors: `models.py#L401`, `file.py:123`, `file.py#L10-L20`.
const LINE_ANCHOR_RE = /(?:[\w.-]+[\\/])*[\w.-]+\.\w+(?:#L\d+(?:-L?\d+)?|:\d+(?:-\d+)?)/g;

// Reproduction commands, restricted to forms the corpus actually contains (§40:
// no general shell parsing). `pytest <path-ish>` requires the argument to look
// like a path or node id — the corpus contains the prose "pytest versions: 5.4.x",
// which is a false positive this shape must reject.
const REPRO_COMMAND_RE =
  /(?:python[0-9.]*\s+-m\s+[\w.]+(?:\s+[\w./:=-]+)*|(?<![\w-])pytest\s+[\w./-]+\.py[\w:.[\]-]*|(?:\.\/)?manage\.py\s+[a-z_]+)/g;

function normalizePathHint(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Structural shape only — never asks the index. See `PathShape`. */
export function classifyPathShape(raw: string): PathShape {
  if (/^<.*>$/.test(raw.trim())) return "interpreter_pseudo";
  if (/^https?:\/\//i.test(raw) || /(?:^|\/)(?:github|gitlab)\.com\//i.test(raw)) return "url";
  const normalized = normalizePathHint(raw);
  if (/(?:^|\/)(?:site-packages|dist-packages)\//.test(normalized)) return "site_packages";
  if (/(?:^|\/)(?:usr\/lib|usr\/local\/lib|Frameworks\/Python\.framework)\//.test(normalized)) return "stdlib";
  if (/^(?:[A-Za-z]:)?\//.test(raw) || /^[\\]/.test(raw)) return "absolute_foreign";
  if (/^(?:Users|home|app|tmp|var|opt|System|Library)\//.test(normalized)) return "absolute_foreign";
  return "repo_relative";
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const k = key(value);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(value);
  }
  return out;
}

/**
 * Pull every raw failure-evidence form out of one task string.
 *
 * Ordering matters for attribution, not for counting: traceback frames are
 * extracted FIRST and their path spans removed from the text the prose scanners
 * see, so a frame path is never double-counted as an "explicit source path the
 * author wrote in prose". Those are different evidence claims (§18) and merging
 * them would inflate the prose lane with traceback noise.
 */
export function extractRawEvidence(task: string): {
  readonly paths: ExtractedPath[];
  readonly exceptionNames: string[];
  readonly failingTestNames: string[];
  readonly reproductionCommands: string[];
  readonly forms: RawEvidenceForm[];
} {
  const paths: ExtractedPath[] = [];

  // --- traceback frames, in order; the last one is the raising site ----------
  const frameMatches = [...task.matchAll(TRACEBACK_FRAME_RE)];
  let prose = task;
  frameMatches.forEach((match, index) => {
    const raw = (match[1] ?? "").trim();
    if (raw.length === 0) return;
    paths.push({
      raw,
      normalized: normalizePathHint(raw),
      shape: classifyPathShape(raw),
      form: "traceback_frame",
      frameSymbol: match[3],
      frameIndex: index + 1,
      raisingFrame: index === frameMatches.length - 1,
    });
  });
  for (const match of frameMatches) prose = prose.replace(match[0], " ");

  // --- prose lanes ------------------------------------------------------------
  for (const match of prose.matchAll(LINE_ANCHOR_RE)) {
    const raw = match[0];
    paths.push({ raw, normalized: normalizePathHint(raw), shape: classifyPathShape(raw), form: "line_anchor" });
  }
  for (const match of prose.matchAll(NODEID_RE)) {
    const raw = match[0];
    paths.push({ raw, normalized: normalizePathHint(raw), shape: classifyPathShape(raw), form: "pytest_nodeid" });
  }
  const anchorSpans = new Set(paths.filter((p) => p.form !== "traceback_frame").map((p) => p.raw));
  for (const match of prose.matchAll(SOURCE_PATH_RE)) {
    const raw = match[0];
    // A path already claimed by a richer form (anchor / node id) is not also a
    // bare prose path mention.
    if ([...anchorSpans].some((span) => span.startsWith(raw))) continue;
    paths.push({
      raw,
      normalized: normalizePathHint(raw),
      shape: classifyPathShape(raw),
      form: "explicit_source_path",
    });
  }

  const exceptionNames = [...new Set([...task.matchAll(EXCEPTION_RE)].map((m) => m[0]))];
  const failingTestNames = [...new Set([...task.matchAll(BARE_TEST_RE)].map((m) => m[0]))];
  const reproductionCommands = [...new Set([...task.matchAll(REPRO_COMMAND_RE)].map((m) => m[0].trim()))];

  const deduped = uniqueBy(paths, (p) => `${p.form}:${p.normalized}:${p.frameIndex ?? ""}`);
  const forms = new Set<RawEvidenceForm>(deduped.map((p) => p.form));
  if (exceptionNames.length > 0) forms.add("exception_name");
  if (failingTestNames.length > 0) forms.add("failing_test_name");
  if (reproductionCommands.length > 0) forms.add("reproduction_command");

  return {
    paths: deduped,
    exceptionNames,
    failingTestNames,
    reproductionCommands,
    forms: RAW_EVIDENCE_FORMS.filter((form) => forms.has(form)),
  };
}

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

interface FixtureCase {
  readonly instance_id: string;
  readonly repo: string;
  readonly workspace: string;
  readonly task: string;
  readonly label_source?: string;
  readonly expected_files?: readonly string[];
}

interface SuiteSpec {
  readonly name: string;
  readonly fixture: string;
  /** Frozen-50 membership — the suite pair the paired benchmark aggregates. */
  readonly frozen50: boolean;
}

const SUITES: readonly SuiteSpec[] = [
  { name: "django_expanded_20", fixture: "retrieval_eval.django.expanded.json", frozen50: true },
  { name: "cross_repo_30", fixture: "retrieval_eval.cross_repo.30.json", frozen50: true },
  { name: "django_5", fixture: "retrieval_eval.django.json", frozen50: false },
  { name: "cross_repo_16", fixture: "retrieval_eval.cross_repo.json", frozen50: false },
];

function goldSuffixMatch(candidate: string, goldFiles: readonly string[]): string[] {
  const cand = candidate.replace(/\\/g, "/");
  return goldFiles.filter((gold) => {
    const g = gold.replace(/\\/g, "/");
    return cand === g || cand.endsWith(`/${g}`) || g.endsWith(`/${cand}`);
  });
}

export function inventoryCase(suite: string, entry: FixtureCase): CaseInventory {
  const raw = extractRawEvidence(entry.task);
  const goldFiles = entry.expected_files ?? [];
  const goldMatchingPaths = raw.paths
    .filter((p) => goldSuffixMatch(p.normalized, goldFiles).length > 0)
    .map((p) => p.normalized);
  const localizing = raw.forms.filter((form) => LOCALIZING_FORMS.includes(form));
  return {
    instanceId: entry.instance_id,
    suite,
    repo: entry.repo,
    labelSource: entry.label_source ?? "unknown",
    taskChars: entry.task.length,
    forms: raw.forms,
    hasAnyEvidence: raw.forms.length > 0,
    hasLocalizingEvidence: localizing.length > 0,
    exceptionNames: raw.exceptionNames,
    failingTestNames: raw.failingTestNames,
    reproductionCommands: raw.reproductionCommands,
    paths: raw.paths,
    evaluationOnly: {
      goldFiles,
      anyPathMatchesGold: goldMatchingPaths.length > 0,
      goldMatchingPaths: [...new Set(goldMatchingPaths)],
    },
  };
}

// ---------------------------------------------------------------------------
// Aggregation + report
// ---------------------------------------------------------------------------

export interface SuiteCounts {
  readonly suite: string;
  readonly cases: number;
  readonly byForm: Record<RawEvidenceForm, number>;
  readonly anyEvidence: number;
  readonly localizingEvidence: number;
  readonly none: number;
  /** Cases whose ONLY evidence is an exception name (symptom, not a place). */
  readonly exceptionNameOnly: number;
}

export function summarizeSuite(suite: string, rows: readonly CaseInventory[]): SuiteCounts {
  const byForm = Object.fromEntries(
    RAW_EVIDENCE_FORMS.map((form) => [form, rows.filter((row) => row.forms.includes(form)).length]),
  ) as Record<RawEvidenceForm, number>;
  return {
    suite,
    cases: rows.length,
    byForm,
    anyEvidence: rows.filter((row) => row.hasAnyEvidence).length,
    localizingEvidence: rows.filter((row) => row.hasLocalizingEvidence).length,
    none: rows.filter((row) => !row.hasAnyEvidence).length,
    exceptionNameOnly: rows.filter((row) => row.hasAnyEvidence && !row.hasLocalizingEvidence).length,
  };
}

function renderCountsTable(summaries: readonly SuiteCounts[]): string {
  const header = `| Evidence form | ${summaries.map((s) => s.suite).join(" | ")} |`;
  const rule = `| --- | ${summaries.map(() => "---:").join(" | ")} |`;
  const rows = RAW_EVIDENCE_FORMS.map(
    (form) => `| ${form} | ${summaries.map((s) => s.byForm[form]).join(" | ")} |`,
  );
  return [
    header,
    rule,
    ...rows,
    `| **any evidence** | ${summaries.map((s) => s.anyEvidence).join(" | ")} |`,
    `| **localizing evidence** | ${summaries.map((s) => s.localizingEvidence).join(" | ")} |`,
    `| exception-name only | ${summaries.map((s) => s.exceptionNameOnly).join(" | ")} |`,
    `| **none** | ${summaries.map((s) => s.none).join(" | ")} |`,
  ].join("\n");
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`Usage: bun ${RUNNER_NAME}.ts [--out <dir>|--evidence]\n${SHARED_RUNNER_OPTIONS_HELP}`);
    return;
  }
  const target = await prepareRunnerOutput({ argv: process.argv, runner: RUNNER_NAME });
  const fixtureDir = path.join(REPO_ROOT, "benchmarks", "stage5_vexp_swe_bench_smoke");

  const bySuite: Array<{ suite: string; rows: CaseInventory[] }> = [];
  for (const suite of SUITES) {
    const parsed = JSON.parse(await readFile(path.join(fixtureDir, suite.fixture), "utf8")) as FixtureCase[];
    bySuite.push({ suite: suite.name, rows: parsed.map((entry) => inventoryCase(suite.name, entry)) });
  }

  // The ARC behavioural corpus is natural-language process questions with no
  // observed-failure text at all. It is inventoried so the "no evidence -> no
  // effect" expectation (§62, §84) rests on a count rather than an assumption.
  const arcRows = [...ARC_BEHAVIORAL_CASES, ...ARC_EXPLICIT_CONTROLS].map((testCase) =>
    inventoryCase("arc_behavioral", {
      instance_id: testCase.id,
      repo: "ReactionMechanismGenerator/ARC",
      workspace: "",
      task: testCase.query,
      label_source: "reconstructed_from_report",
      expected_files: testCase.expectedOwnerFile.length > 0 ? [testCase.expectedOwnerFile] : [],
    }),
  );
  bySuite.push({ suite: "arc_behavioral", rows: arcRows });

  const frozen50Rows = bySuite
    .filter((entry) => SUITES.find((s) => s.name === entry.suite)?.frozen50 === true)
    .flatMap((entry) => entry.rows);

  const summaries = [
    ...bySuite.map((entry) => summarizeSuite(entry.suite, entry.rows)),
    summarizeSuite("frozen50 (aggregate)", frozen50Rows),
  ];

  const allRows = bySuite.flatMap((entry) => entry.rows);

  // §30/§81: the django-11740 determination is a REQUIRED early output.
  const django11740 = allRows.find((row) => row.instanceId === "django__django-11740") ?? null;

  const artifact = {
    schemaVersion: "stage5.m144.failure-evidence-inventory.v1",
    milestone: "M144-A",
    section: "§16 inventory, §17 required output, §77 activation denominators",
    method:
      "Liberal audit-side extraction of raw failure-LIKE text from the task string each "
      + "suite actually feeds buildCapsuleV2. No index resolution (that is Workstream B, §93). "
      + "Gold files are carried for evaluation-only reporting and never used to classify.",
    suites: summaries,
    django11740: django11740 === null
      ? { present: false }
      : {
        present: true,
        hasAnyEvidence: django11740.hasAnyEvidence,
        hasLocalizingEvidence: django11740.hasLocalizingEvidence,
        forms: django11740.forms,
        labelSource: django11740.labelSource,
        determination: django11740.hasLocalizingEvidence
          ? "addressable_under_supplied_evidence_scope"
          : "not_addressable_under_supplied_evidence_scope",
      },
    cases: allRows,
  };

  await writeFile(
    path.join(target.dir, "stage5_m144_failure_evidence_inventory.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );

  const report = [
    "# M144-A — Failure-evidence inventory",
    "",
    "Counts of raw failure-LIKE text in the task string each suite feeds `buildCapsuleV2`.",
    "Liberal by design: this is the denominator §77 uses to separate *a parser exists* from",
    "*the capability is useful*. No index resolution here — that is Workstream B.",
    "",
    renderCountsTable(summaries),
    "",
    "## django-11740 (§30, §81 — required early determination)",
    "",
    django11740 === null
      ? "- NOT PRESENT in the inventoried corpus."
      : [
        `- label source: \`${django11740.labelSource}\``,
        `- task: \`${django11740.taskChars}\` chars`,
        `- raw evidence forms: ${django11740.forms.length === 0 ? "**none**" : django11740.forms.join(", ")}`,
        `- localizing evidence: **${django11740.hasLocalizingEvidence ? "yes" : "no"}**`,
        `- determination: **${django11740.hasLocalizingEvidence
          ? "addressable under the supplied-evidence scope"
          : "NOT addressable under the M144 supplied-evidence scope"}**`,
      ].join("\n"),
    "",
    "## Cases carrying localizing evidence",
    "",
    ...allRows
      .filter((row) => row.hasLocalizingEvidence)
      .map((row) => `- \`${row.instanceId}\` (${row.suite}): ${row.forms.join(", ")}`),
    "",
  ].join("\n");

  await writeFile(path.join(target.dir, "stage5_m144_failure_evidence_inventory.md"), `${report}\n`);
  console.log(`wrote inventory to ${target.dir} (tracked evidence: ${target.writesTrackedEvidence})`);
}

if (import.meta.main) {
  await main();
}
