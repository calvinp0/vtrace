/**
 * M189-A — corpus adequacy ledger.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m189_corpus.ts
 *
 * Answers question A of §4 — "is the current evidence corpus adequate?" — for I5 and I6
 * SEPARATELY, over every preserved live-agent arm this repository holds, not just M183's.
 * §8's evidence priority is a search order, not a scope: M183 is the primary stratum and is
 * reported as one, but an arm from any milestone that carries an ordered tool trace, a
 * replayable edit chronology and a resolvable base revision is evidence about whether the
 * mechanism is observable, and excluding it would let a negative result be an artifact of
 * how few runs one milestone happened to preserve.
 *
 * WHAT MAKES A NUMBER HERE TRUSTWORTHY. Two things.
 *
 *   The diff is REPLAYED, not assumed. An arm counts as I5-usable only if every recorded
 *   mutation applies to the base tree exactly — `old_string` found, and found the number of
 *   times the call's `replace_all` implies. §9 warns against pretending a final diff reveals
 *   when an agent knew something; the guard against that is to actually rebuild the tree at
 *   each ordinal and fail loudly when it cannot be rebuilt.
 *
 *   Validation is classified by the SHARED authority (`validationExecution.ts`, M187), which
 *   takes an evidence record with no outcome field. M189 adds no test-detection rule of its
 *   own, so an I6 adequacy count cannot drift away from the number M187 published.
 *
 * READS NO GOLD. The dataset is opened for `repo` and `base_commit` only; `patch`,
 * `test_patch`, `FAIL_TO_PASS` and `PASS_TO_PASS` are not read by this script. `resolved` is
 * recorded on the row for stratification of the OUTPUT, and reaches no adequacy predicate —
 * `ArmObservability` has no field to carry it (§12).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  assessI5,
  assessI6,
  decisionPoints,
  reconstructEditChronology,
  type ArmObservability,
  type CallCategory,
  type TraceCall,
} from "./m189Evidence";
import { classifyValidationExecution, type ValidationEvidence } from "./validationExecution";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const RUNS = path.join(RESULTS, "runs");
const CORPUS = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const BENCH_REPOS = "/home/calvin/code/vexp-swe-bench/.bench-repos";
const PATH_PREFIX = `${BENCH_REPOS}/`;

// ── dataset: repo + base revision only ──────────────────────────────────────

interface Instance { readonly repo: string; readonly baseCommit: string }
const instances = new Map<string, Instance>();
for (const line of readFileSync(CORPUS, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const row = JSON.parse(line) as { instance_id: string; repo: string; base_commit: string };
  instances.set(row.instance_id, { repo: row.repo, baseCommit: row.base_commit });
}

const repoDir = (repo: string): string => path.join(BENCH_REPOS, repo.replace("/", "__"));

const commitPresent = new Map<string, boolean>();
function baseTreeAvailable(inst: Instance): boolean {
  const key = `${inst.repo}@${inst.baseCommit}`;
  const cached = commitPresent.get(key);
  if (cached !== undefined) return cached;
  let ok = false;
  const dir = repoDir(inst.repo);
  if (existsSync(dir)) {
    try {
      execFileSync("git", ["-C", dir, "cat-file", "-e", `${inst.baseCommit}^{commit}`], { stdio: "ignore" });
      ok = true;
    } catch { ok = false; }
  }
  commitPresent.set(key, ok);
  return ok;
}

const blobCache = new Map<string, string | null>();
function blobAt(inst: Instance, relPath: string): string | null {
  const key = `${inst.repo}@${inst.baseCommit}:${relPath}`;
  const cached = blobCache.get(key);
  if (cached !== undefined) return cached;
  let content: string | null = null;
  try {
    content = execFileSync("git", ["-C", repoDir(inst.repo), "show", `${inst.baseCommit}:${relPath}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch { content = null; }
  blobCache.set(key, content);
  return content;
}

// ── arm enumeration ─────────────────────────────────────────────────────────

interface RawCall {
  readonly index: number; readonly tool: string; readonly category: string;
  readonly path?: string | null; readonly command?: string | null; readonly output?: string | null;
  readonly success?: boolean | null; readonly exitCode?: number | null; readonly truncated?: boolean;
  readonly args?: Record<string, unknown>;
}

interface Arm {
  readonly runLabel: string;
  readonly family: string;
  readonly month: string;
  readonly model: string;
  readonly rawDir: string;
  readonly instanceId: string;
  readonly repo: string;
  readonly resolved: boolean;
  readonly calls: readonly TraceCall[];
  readonly finalPatch: string | null;
}

const familyOf = (label: string): string => /^(m\d+[a-z]?)_/u.exec(label)?.[1] ?? "other";

const toCategory = (c: string): CallCategory =>
  c === "read" || c === "search" || c === "edit" ? c : "other";

function loadArms(): readonly Arm[] {
  const arms: Arm[] = [];
  for (const runLabel of readdirSync(RUNS).sort()) {
    const rawRoot = path.join(RUNS, runLabel, "raw");
    if (!existsSync(rawRoot)) continue;
    for (const condition of readdirSync(rawRoot).sort()) {
      const rawDir = path.join(rawRoot, condition);
      const tcPath = path.join(rawDir, "_tool_calls.json");
      if (!existsSync(tcPath)) continue;
      const resultFile = readdirSync(rawDir).find((f) => /^swebench-.*\.jsonl$/u.test(f));
      if (resultFile === undefined) continue;
      let row: Record<string, unknown>;
      try {
        const first = readFileSync(path.join(rawDir, resultFile), "utf8").split("\n").find((l) => l.trim());
        if (first === undefined) continue;
        row = JSON.parse(first) as Record<string, unknown>;
      } catch { continue; }
      const instanceId = typeof row.instanceId === "string" ? row.instanceId : null;
      if (instanceId === null || !instances.has(instanceId)) continue;

      let withArgs: RawCall[]; let withOutputs: RawCall[];
      try { withArgs = JSON.parse(readFileSync(tcPath, "utf8")) as RawCall[]; } catch { continue; }
      const woPath = path.join(rawDir, "_tool_calls_with_outputs.json");
      try {
        withOutputs = existsSync(woPath) ? (JSON.parse(readFileSync(woPath, "utf8")) as RawCall[]) : [];
      } catch { withOutputs = []; }
      const outById = new Map(withOutputs.map((c) => [c.index, c]));

      const calls: TraceCall[] = withArgs.map((c) => {
        const o = outById.get(c.index);
        return {
          index: c.index,
          tool: c.tool,
          category: toCategory(c.category),
          path: c.path ?? null,
          command: o?.command ?? (typeof c.args?.command === "string" ? c.args.command : null),
          output: o?.output ?? null,
          args: c.args ?? {},
        };
      });
      // Any call present only in the outputs file (a phase the args file omitted) still counts
      // as a trace event for validation purposes; it is appended rather than dropped.
      const known = new Set(calls.map((c) => c.index));
      for (const o of withOutputs) {
        if (known.has(o.index)) continue;
        calls.push({ index: o.index, tool: o.tool, category: toCategory(o.category), path: o.path ?? null, command: o.command ?? null, output: o.output ?? null, args: {} });
      }
      calls.sort((a, b) => a.index - b.index);

      const patch = typeof row.modelPatch === "string" ? row.modelPatch : null;
      arms.push({
        runLabel, family: familyOf(runLabel), rawDir: path.relative(REPO_ROOT, rawDir),
        month: typeof row.timestamp === "string" ? row.timestamp.slice(0, 7) : "unknown",
        model: typeof row.model === "string" ? row.model : "unknown",
        instanceId, repo: instances.get(instanceId)!.repo,
        resolved: row.resolved === true || row.resolved === "True" || row.resolved === 1,
        calls, finalPatch: patch !== null && patch.trim() !== "" ? patch : null,
      });
    }
  }
  return arms;
}

// ── diff replay ─────────────────────────────────────────────────────────────

const relOf = (p: string | null): string | null => {
  if (p === null || !p.startsWith(PATH_PREFIX)) return null;
  const rest = p.slice(PATH_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash < 0 ? null : rest.slice(slash + 1);
};

interface ReplayResult {
  readonly clean: boolean;
  readonly appliedOps: number;
  readonly failures: readonly { readonly callIndex: number; readonly file: string; readonly why: string }[];
  /** file -> content, after every op that applied */
  readonly tree: ReadonlyMap<string, string>;
  readonly touchedFiles: readonly string[];
}

function replay(arm: Arm, inst: Instance): ReplayResult {
  const chronology = reconstructEditChronology(arm.calls);
  const tree = new Map<string, string>();
  const failures: { callIndex: number; file: string; why: string }[] = [];
  const touched = new Set<string>();
  let applied = 0;
  for (const op of chronology.ops) {
    const rel = relOf(op.file);
    if (rel === null) { failures.push({ callIndex: op.callIndex, file: op.file, why: "PATH_OUTSIDE_BENCH_REPO" }); continue; }
    touched.add(rel);
    if (op.kind === "write") {
      tree.set(rel, op.newString ?? "");
      applied += 1;
      continue;
    }
    let current = tree.get(rel);
    if (current === undefined) {
      const blob = blobAt(inst, rel);
      if (blob === null) { failures.push({ callIndex: op.callIndex, file: rel, why: "FILE_ABSENT_AT_BASE" }); continue; }
      current = blob;
    }
    const needle = op.oldString ?? "";
    if (needle === "") { failures.push({ callIndex: op.callIndex, file: rel, why: "EMPTY_OLD_STRING" }); continue; }
    const occurrences = current.split(needle).length - 1;
    if (occurrences === 0) { failures.push({ callIndex: op.callIndex, file: rel, why: "OLD_STRING_NOT_FOUND" }); continue; }
    if (occurrences > 1 && !op.replaceAll) { failures.push({ callIndex: op.callIndex, file: rel, why: "OLD_STRING_AMBIGUOUS" }); continue; }
    tree.set(rel, op.replaceAll ? current.split(needle).join(op.newString ?? "") : current.replace(needle, op.newString ?? ""));
    applied += 1;
  }
  return { clean: failures.length === 0 && applied === chronology.ops.length && applied > 0, appliedOps: applied, failures, tree, touchedFiles: [...touched].sort() };
}

// ── validation classification (shared M187 authority) ───────────────────────

const exitCodeFromText = (output: string | null): number | null => {
  if (output === null) return null;
  const m = /^Exit code (\d{1,3})(?:\n|$)/u.exec(output);
  return m === null ? null : Number(m[1]);
};

interface ValidationTimeline {
  readonly attemptIndices: readonly number[];
  readonly startedIndices: readonly number[];
  readonly resultIndices: readonly number[];
}

function validationTimeline(arm: Arm): ValidationTimeline {
  const attempts: number[] = []; const started: number[] = []; const results: number[] = [];
  for (const c of arm.calls) {
    const evidence: ValidationEvidence = {
      tool: c.tool, command: c.command, output: c.output, success: null,
      exitCode: exitCodeFromText(c.output), exitCodeSource: "output_prefix", truncated: false,
    };
    const record = classifyValidationExecution(evidence);
    if (record === null) continue;
    attempts.push(c.index);
    if (record.runnerStarted === true) started.push(c.index);
    if (record.state === "STARTED_PASSED" || record.state === "STARTED_FAILED") results.push(c.index);
  }
  return { attemptIndices: attempts, startedIndices: started, resultIndices: results };
}

// ── ledger ──────────────────────────────────────────────────────────────────

const arms = loadArms();
const rows = arms.map((arm) => {
  const inst = instances.get(arm.instanceId)!;
  const chronology = reconstructEditChronology(arm.calls);
  const hasBase = baseTreeAvailable(inst);
  const rep = hasBase && chronology.ops.length > 0
    ? replay(arm, inst)
    : { clean: false, appliedOps: 0, failures: [], tree: new Map<string, string>(), touchedFiles: [] as readonly string[] };
  const vt = validationTimeline(arm);
  const firstEdit = chronology.ops[0]?.callIndex ?? null;

  const observability: ArmObservability = {
    orderedToolTrace: arm.calls.length > 0,
    editCalls: new Set(chronology.ops.map((o) => o.callIndex)).size,
    editOps: chronology.ops.length,
    editChronologyComplete: chronology.complete,
    baseTreeAvailable: hasBase,
    finalPatchAvailable: arm.finalPatch !== null,
    inspectionCalls: arm.calls.filter((c) => c.category === "read" || c.category === "search").length,
    callsAfterFirstEdit: firstEdit === null ? 0 : arm.calls.filter((c) => c.index > firstEdit).length,
    diffReplayClean: rep.clean,
    validationAttempts: vt.attemptIndices.length,
    validationRunnerStarts: vt.startedIndices.length,
    validationResultsObserved: vt.resultIndices.length,
    editsAfterValidationStart: vt.startedIndices.length === 0 ? 0
      : chronology.ops.filter((o) => o.callIndex > vt.startedIndices[0]!).length,
  };
  const i5 = assessI5(observability);
  const i6 = assessI6(observability, i5);
  const dps = decisionPoints({
    calls: arm.calls, chronology,
    validationAttemptIndices: vt.attemptIndices, validationStartedIndices: vt.startedIndices,
  });

  return {
    runLabel: arm.runLabel, family: arm.family, rawDir: arm.rawDir, month: arm.month, model: arm.model,
    instanceId: arm.instanceId, repo: arm.repo, baseCommit: inst.baseCommit,
    resolved: arm.resolved,
    observability,
    replayFailures: rep.failures.slice(0, 6),
    changedFiles: rep.touchedFiles,
    decisionPoints: dps,
    usableForI5: i5.usable, i5Blockers: i5.blockers,
    usableForI6: i6.usable, i6Blockers: i6.blockers,
  };
});

const count = (p: (r: (typeof rows)[number]) => boolean): number => rows.filter(p).length;
const tally = (key: (r: (typeof rows)[number]) => readonly string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) for (const k of key(r)) out[k] = (out[k] ?? 0) + 1;
  return out;
};

const strata = ["ALL", "m183"] as const;
const summaryFor = (pred: (r: (typeof rows)[number]) => boolean) => {
  const s = rows.filter(pred);
  const c = (p: (r: (typeof rows)[number]) => boolean): number => s.filter(p).length;
  return {
    candidateArms: s.length,
    repositories: new Set(s.map((r) => r.repo)).size,
    tasks: new Set(s.map((r) => r.instanceId)).size,
    withOrderedTrace: c((r) => r.observability.orderedToolTrace),
    withAtLeastOneEdit: c((r) => r.observability.editOps > 0),
    withCompleteEditChronology: c((r) => r.observability.editChronologyComplete),
    withBaseTree: c((r) => r.observability.baseTreeAvailable),
    withReplayableDiff: c((r) => r.observability.diffReplayClean),
    i5Usable: c((r) => r.usableForI5),
    i5UsableFailures: c((r) => r.usableForI5 && !r.resolved),
    i5UsableSuccesses: c((r) => r.usableForI5 && r.resolved),
    i5UsableFailureRepositories: new Set(s.filter((r) => r.usableForI5 && !r.resolved).map((r) => r.repo)).size,
    validationAttempted: c((r) => r.observability.validationAttempts > 0),
    validationRunnerStarted: c((r) => r.observability.validationRunnerStarts > 0),
    validationResultObserved: c((r) => r.observability.validationResultsObserved > 0),
    validationResultThenEdit: c((r) => r.observability.validationResultsObserved > 0 && r.observability.editsAfterValidationStart > 0),
    i6Usable: c((r) => r.usableForI6),
    i6UsableFailures: c((r) => r.usableForI6 && !r.resolved),
    i6UsableRepositories: new Set(s.filter((r) => r.usableForI6).map((r) => r.repo)).size,
  };
};

/**
 * §8's evidence-source priority, recorded as a register rather than a claim. Each row says
 * what was searched, what it contributed, and — for the sources that contributed nothing —
 * WHY, so that a later milestone does not re-search them hoping for a different answer.
 */
const sourceRegister = [
  {
    priority: 1, source: "M183 preserved live artifacts (results/runs/m183_*/raw/*)",
    searched: true, contributed: "60 arms: ordered tool calls with full Edit payloads, agent stream, result rows, eval meta",
    role: "primary I5 stratum; the frozen default-path corpus",
  },
  {
    priority: 2, source: "M185 derived failure corpus (stage5_m185_*.json)",
    searched: true, contributed: "cohort definitions and the six correct-focus failures, used to cross-check this milestone's failure population",
    role: "reconciliation only — M189 re-derives its own cohorts from the raw traces",
  },
  {
    priority: 3, source: "M187 validation artifacts + validationExecution.ts",
    searched: true, contributed: "the shared, outcome-blind validation-execution classifier reused verbatim; M183's 14 attempts / 5 runner starts reproduced",
    role: "the I6 adequacy predicate is M187's attributability condition",
  },
  {
    priority: 4, source: "M188 competitor research artifacts (stage5_m188_*.json)",
    searched: true, contributed: "the I5/I6 hypothesis statements and the warning that the M183 corpus cannot witness a post-validation mechanism",
    role: "motivation for which mechanism to inspect; no evidence weight (§28)",
  },
  {
    priority: 5, source: "every other preserved live-agent trace under results/runs/",
    searched: true, contributed: "1233 further arms across 37 milestone families, 12 repositories, one model",
    role: "decisive — it is the ONLY source in this repository that contains observed test-runner execution at scale",
  },
  {
    priority: 6, source: "external traces captured by M188",
    searched: true, contributed: "nothing usable: the audited external artifacts carry published resolved-id sets and per-task summaries, not ordered tool calls or edit payloads",
    role: "cannot witness a decision point; excluded",
  },
  {
    priority: 7, source: "committed benchmark artifacts outside results/runs/",
    searched: true, contributed: "nothing usable: derived reports and scorecards, no per-call chronology",
    role: "excluded",
  },
] as const;

const ledger = {
  schemaVersion: "stage5.m189.corpus-adequacy.v1",
  sourceRegister,
  milestone: "M189",
  workstream: "M189-A",
  goldRead: false,
  outcomeReachesAdequacyPredicate: false,
  populationRule:
    "every directory results/runs/<label>/raw/<condition>/ carrying _tool_calls.json and a swebench-*.jsonl row whose instanceId is in SWE-bench Verified",
  i5UsabilityRule:
    "ordered trace AND >=1 replayable mutation AND base revision resolvable AND every mutation applies cleanly to the base tree AND a final patch exists",
  i6UsabilityRule:
    "I5-usable AND >=1 validation attempt AND >=1 observed runner start AND >=1 observed pass/fail result — the attributability condition of M187",
  strata: {
    ALL: summaryFor(() => true),
    m183: summaryFor((r) => r.family === "m183"),
  },
  i5BlockerCounts: tally((r) => r.i5Blockers),
  i6BlockerCounts: tally((r) => r.i6Blockers),
  // The environment era split (§23/§24). Same model throughout; what changes is whether the
  // benchmark repositories had a working dependency environment, which is the single fact
  // that decides whether I6 is observable at all.
  byMonth: Object.fromEntries(
    [...new Set(rows.map((r) => r.month))].sort().map((m) => [m, {
      arms: count((r) => r.month === m),
      models: [...new Set(rows.filter((r) => r.month === m).map((r) => r.model))].sort(),
      i5Usable: count((r) => r.month === m && r.usableForI5),
      validationAttempted: count((r) => r.month === m && r.observability.validationAttempts > 0),
      runnerStarted: count((r) => r.month === m && r.observability.validationRunnerStarts > 0),
      i6Usable: count((r) => r.month === m && r.usableForI6),
    }]),
  ),
  byFamily: Object.fromEntries(
    [...new Set(rows.map((r) => r.family))].sort().map((f) => [f, {
      arms: count((r) => r.family === f),
      i5Usable: count((r) => r.family === f && r.usableForI5),
      i6Usable: count((r) => r.family === f && r.usableForI6),
    }]),
  ),
  i6UsableArms: rows.filter((r) => r.usableForI6).map((r) => ({
    runLabel: r.runLabel, instanceId: r.instanceId, repo: r.repo, resolved: r.resolved,
    attempts: r.observability.validationAttempts,
    starts: r.observability.validationRunnerStarts,
    results: r.observability.validationResultsObserved,
    editsAfterValidationStart: r.observability.editsAfterValidationStart,
  })),
  strataNote: strata.join("/"),
};

writeFileSync(path.join(RESULTS, "stage5_m189_corpus_adequacy.json"), `${JSON.stringify(ledger, null, 2)}\n`);
writeFileSync(
  path.join(RESULTS, "stage5_m189_corpus_ledger.jsonl"),
  `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
);

const s = ledger.strata.ALL; const m = ledger.strata.m183;
process.stdout.write(
  [
    `M189-A corpus adequacy`,
    `  candidate arms          ALL ${s.candidateArms}   m183 ${m.candidateArms}`,
    `  repositories            ALL ${s.repositories}   m183 ${m.repositories}`,
    `  with >=1 edit           ALL ${s.withAtLeastOneEdit}   m183 ${m.withAtLeastOneEdit}`,
    `  replayable diff         ALL ${s.withReplayableDiff}   m183 ${m.withReplayableDiff}`,
    `  I5-usable               ALL ${s.i5Usable}   m183 ${m.i5Usable}`,
    `  I5-usable failures      ALL ${s.i5UsableFailures} (${s.i5UsableFailureRepositories} repos)   m183 ${m.i5UsableFailures}`,
    `  validation attempted    ALL ${s.validationAttempted}   m183 ${m.validationAttempted}`,
    `  runner started          ALL ${s.validationRunnerStarted}   m183 ${m.validationRunnerStarted}`,
    `  result observed         ALL ${s.validationResultObserved}   m183 ${m.validationResultObserved}`,
    `  result then edit        ALL ${s.validationResultThenEdit}   m183 ${m.validationResultThenEdit}`,
    `  I6-usable               ALL ${s.i6Usable} (${s.i6UsableRepositories} repos)   m183 ${m.i6Usable}`,
    ``,
  ].join("\n"),
);
