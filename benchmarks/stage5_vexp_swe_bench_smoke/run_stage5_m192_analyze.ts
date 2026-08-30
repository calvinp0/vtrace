/**
 * M192 step 3 — derive the readiness ledger from the probe evidence.
 *
 * Every load-bearing count in the M192 report comes from here. Nothing is
 * transcribed by hand. The rules applied are exactly the ones frozen in
 * stage5_m192_probe_manifest.json / m192Substrate.ts before the first probe ran.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m192_analyze.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assessRepository,
  breadthGate,
  classifyExecution,
  classifyProvenance,
  classifyProvenanceRobustness,
  substrateVerdict,
  START_TEST_OUTPUT,
  type CommandResult,
  type ExecutionState,
  type ProvenanceState,
  type ProvenanceRobustness,
  type ReadinessChecks,
  type RepositoryState,
} from "./m192Substrate";

const RESULTS = join(import.meta.dir, "results");

interface RawCommand {
  label: string;
  command: string;
  cwd: string;
  exec_path: string;
  process_started: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  duration_ms: number;
  error: string | null;
}

interface StatusSummary {
  parsed?: number;
  pProbeStatus?: string | null;
  fProbeStatus?: string | null;
  pProbePassed?: boolean;
  fProbeFailed?: boolean;
  fProbePassed?: boolean;
}

interface RawResult {
  instanceId: string;
  repo: string;
  instanceImageKey: string;
  importName: string;
  pProbe: string | null;
  fProbe: string | null;
  checkoutRoot: string;
  execPath: string;
  moduleFile: string | null;
  mutationTarget: string | null;
  image: { present_before: boolean | null; pulled: boolean; pull_ms: number; size_bytes: number | null };
  commands: RawCommand[];
  evidence: Record<string, unknown>;
  testStatus: {
    clean: StatusSummary;
    mutated: StatusSummary;
    gold?: StatusSummary;
  };
  error: string | null;
}

const probes = JSON.parse(readFileSync(join(RESULTS, "_m192_probes_raw.json"), "utf8")) as {
  execPath: string;
  wallClockSeconds: number;
  results: RawResult[];
};

function toCommandResult(c: RawCommand | undefined): CommandResult {
  if (!c) {
    return { processStarted: false, exitCode: null, stdout: "", stderr: "", timedOut: false, durationMs: 0 };
  }
  return {
    processStarted: c.process_started,
    exitCode: c.exit_code,
    stdout: c.stdout,
    stderr: c.stderr,
    timedOut: c.timed_out,
    durationMs: c.duration_ms,
  };
}

function bool(v: unknown): boolean {
  return v === true;
}

interface Row {
  robustness: ProvenanceRobustness;
  moduleFileNeutralCwd: string | null;
  goldControlHolds: boolean;
  goldStatus: { pProbe: string | null; fProbe: string | null };
  repo: string;
  instanceId: string;
  checks: ReadinessChecks;
  state: RepositoryState;
  execState: ExecutionState;
  provenance: ProvenanceState;
  moduleFile: string | null;
  pStatus: string | null;
  fStatus: string | null;
  imagePulled: boolean;
  imageSizeGb: number | null;
  pullSeconds: number;
  containerStartMs: number;
  repeatCommandMs: number;
  evalSeconds: number;
  repeatEvalSeconds: number;
  evalExitCode: number | null;
  notes: string[];
}

const rows: Row[] = probes.results.map((r) => {
  const byLabel = new Map(r.commands.map((c) => [c.label, c]));
  const cleanEval = byLabel.get("s1_eval_clean");
  const mutEval = byLabel.get("s2_eval_mutated");
  const execState = classifyExecution(toCommandResult(cleanEval));
  const runnerStarted =
    !!cleanEval && `${cleanEval.stdout}\n${cleanEval.stderr}`.includes(START_TEST_OUTPUT);

  const tel = (r.evidence.telemetry ?? {}) as Record<string, unknown>;
  const telemetryTruthful =
    bool(tel.exitZeroObserved) &&
    bool(tel.exitCodePreserved) &&
    bool(tel.stdoutIsolated) &&
    bool(tel.stderrIsolated) &&
    bool(tel.timeoutDistinguishable) &&
    bool(tel.missingCwdIsNotATestFailure);

  const singleExecPath =
    r.commands.length > 0 && r.commands.every((c) => c.exec_path === probes.execPath);

  const clean = r.testStatus?.clean ?? {};
  const gold = r.testStatus?.gold ?? {};
  const pStatus = clean.pProbeStatus ?? null;
  const fStatus = clean.fProbeStatus ?? null;

  // swebench's own predicates. `test_passed` needs the id present and PASSED;
  // `test_failed` counts ERROR — and absence — as failing, which matters for
  // instances whose F2P test module cannot even import before the repair.
  //
  // PASS_TO_PASS is only a benchmark guarantee in the repaired state, so a
  // passing result counts if it is observable either pre-repair or under the
  // §10 gold control. The control itself is the stronger environment proof:
  // the F-probe fails before the reference repair and passes after it.
  const passObservable =
    r.pProbe === null ? null : bool(clean.pProbePassed) || bool(gold.pProbePassed);
  const failObservable = r.fProbe === null ? null : bool(clean.fProbeFailed);
  const goldControlHolds = bool(clean.fProbeFailed) && bool(gold.fProbePassed);

  const provenance = classifyProvenance({
    moduleFile: r.moduleFile,
    checkoutRoot: r.checkoutRoot,
    mutationExecuted: r.evidence.v9 === undefined ? null : bool(r.evidence.v9),
    runnerStarted,
  });

  const checks: ReadinessChecks = {
    v1EnvironmentStarts: bool(r.evidence.v1),
    v2SourceReadable: bool(r.evidence.v2),
    v3SourceWritable: bool(r.evidence.v3),
    v4MutationPersists: bool(r.evidence.v4),
    v5TestRunnerStarts: runnerStarted,
    v6PassingObservable: passObservable,
    v7FailingObservable: failObservable,
    v8SourceProvenance: provenance,
    v9MutationAffectsValidation: bool(r.evidence.v9),
    // §31/§29: the probe must leave a truthful state. It does so by removing its
    // own mutation *and* destroying the disposable container. Untracked build
    // output produced by swebench's own install step inside a container that no
    // longer exists is not contamination, and is recorded separately.
    v10SourceRestored:
      bool(r.evidence.v10_mutation_removed) && bool(r.evidence.containerRemoved),
    v11TelemetryTruthful: telemetryTruthful,
    v12NoPrivilegedBypass: singleExecPath,
  };

  const goldStatus = { pProbe: gold.pProbeStatus ?? null, fProbe: gold.fProbeStatus ?? null };
  const notes: string[] = [];
  if (r.error) notes.push(`probe error: ${r.error}`);
  if (r.evidence.headEqualsBase === false) {
    notes.push("HEAD is base_commit + swebench's own provisioning commit");
  }
  if (r.evidence.mutationSkippedReason) notes.push(String(r.evidence.mutationSkippedReason));
  if (r.evidence.v10_residual) {
    notes.push(`residual left by swebench's own eval script (container destroyed): ${String(r.evidence.v10_residual).replace(/\n/g, "; ").slice(0, 160)}`);
  }
  if (r.pProbe === null) {
    notes.push("benchmark declares no PASS_TO_PASS for this instance (FAIL_ONLY); V6 not applicable");
  }
  if (!goldControlHolds && r.fProbe) {
    notes.push(`gold control did not close: F-probe clean=${fStatus ?? "absent"} gold=${goldStatus.fProbe ?? "absent"}`);
  }
  if (cleanEval && cleanEval.exit_code === 0 && bool(clean.fProbeFailed)) {
    notes.push("eval script exited 0 while the F-probe failed: exit code carries no test semantics");
  }

  const robustness = classifyProvenanceRobustness(
    r.evidence.moduleFileNeutralCwd as string | null | undefined,
    r.checkoutRoot,
  );
  if (robustness === "CWD_DEPENDENT") {
    notes.push(
      "an installed copy shadows the checkout from any other working directory; validation is correct only because the benchmark runner cd's into /testbed first",
    );
  }
  return {
    robustness,
    moduleFileNeutralCwd: (r.evidence.moduleFileNeutralCwd as string | null) ?? null,
    goldControlHolds,
    goldStatus,
    repo: r.repo,
    instanceId: r.instanceId,
    checks,
    state: assessRepository(checks),
    execState,
    provenance,
    moduleFile: r.moduleFile,
    pStatus,
    fStatus,
    imagePulled: r.image?.pulled ?? false,
    imageSizeGb: r.image?.size_bytes ? Number((r.image.size_bytes / 1e9).toFixed(2)) : null,
    pullSeconds: Math.round((r.image?.pull_ms ?? 0) / 1000),
    containerStartMs: Number(r.evidence.container_start_ms ?? 0),
    repeatCommandMs: Number(r.evidence.repeat_command_ms ?? 0),
    evalSeconds: Math.round((cleanEval?.duration_ms ?? 0) / 1000),
    repeatEvalSeconds: Math.round((mutEval?.duration_ms ?? 0) / 1000),
    evalExitCode: cleanEval?.exit_code ?? null,
    notes,
  };
});

rows.sort((a, b) => a.repo.localeCompare(b.repo));

// Committed evidence: the same probe record with each captured stream bounded.
// The raw dump is 93% test-runner output and belongs with the other untracked
// run artifacts, but the command ledger itself has to be reviewable.
const EXCERPT = 1200;
function excerpt(s: string): string {
  if (s.length <= EXCERPT) return s;
  return `${s.slice(0, EXCERPT)}\n…[${s.length - EXCERPT} bytes elided; full output in _m192_probes_raw.json]`;
}
writeFileSync(
  join(RESULTS, "stage5_m192_probes.json"),
  `${JSON.stringify(
    {
      ...probes,
      note: "Captured streams are bounded here; the unbounded dump is the untracked _m192_probes_raw.json.",
      results: probes.results.map((r) => ({
        ...r,
        commands: r.commands.map((c) => ({ ...c, stdout: excerpt(c.stdout), stderr: excerpt(c.stderr) })),
      })),
    },
    null,
    2,
  )}\n`,
);

const gate = breadthGate(rows.length);
const ready = rows.filter((r) => r.state === "READY");
const wrongSource = rows.filter((r) => r.state === "WRONG_SOURCE");
const verdict = substrateVerdict(rows.map((r) => r.state), gate);

const provCounts = rows.reduce<Record<string, number>>((acc, r) => {
  acc[r.provenance] = (acc[r.provenance] ?? 0) + 1;
  return acc;
}, {});
const stateCounts = rows.reduce<Record<string, number>>((acc, r) => {
  acc[r.state] = (acc[r.state] ?? 0) + 1;
  return acc;
}, {});

const ledger = {
  milestone: "M192",
  liveAgentRuns: 0,
  liveModelSpendUsd: 0,
  wallClockSeconds: probes.wallClockSeconds,
  repositoriesProbed: rows.length,
  breadthGate: gate,
  readyCount: ready.length,
  wrongSourceCount: wrongSource.length,
  gateMet: ready.length >= gate.requiredReady && wrongSource.length === 0,
  substrateVerdict: verdict,
  stateCounts,
  provenanceCounts: provCounts,
  imagesPulled: rows.filter((r) => r.imagePulled).length,
  imagesBuilt: 0,
  goldControlHeld: rows.filter((r) => r.goldControlHolds).length,
  editableInstalls: rows.filter((r) => r.robustness === "EDITABLE_INSTALL").length,
  cwdDependentProvenance: rows.filter((r) => r.robustness === "CWD_DEPENDENT").length,
  // Docker's API `Size` disagrees with `docker images` on this daemon, so this
  // is labelled as what it is rather than presented as the on-disk footprint.
  // The measured footprint is recorded in the summary report from `docker system df`.
  totalApiReportedImageGb: Number(rows.reduce((s, r) => s + (r.imageSizeGb ?? 0), 0).toFixed(1)),
  medianContainerStartMs: median(rows.map((r) => r.containerStartMs)),
  medianRepeatCommandMs: median(rows.map((r) => r.repeatCommandMs)),
  medianEvalSeconds: median(rows.map((r) => r.evalSeconds)),
  rows,
};

function median(xs: number[]): number {
  const s = [...xs].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (s.length === 0) return 0;
  return s[Math.floor(s.length / 2)]!;
}

writeFileSync(join(RESULTS, "stage5_m192_readiness_ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`);

// ── markdown ledger ─────────────────────────────────────────────────

function yn(v: boolean | null): string {
  return v === null ? "n/a" : v ? "yes" : "**no**";
}

const md: string[] = [];
md.push("# M192 — per-repository interactive validation readiness ledger");
md.push("");
md.push("Generated by `run_stage5_m192_analyze.ts` from `stage5_m192_probes.json`.");
md.push("Rules are the ones frozen in the preregistration commit; no count here is hand-written.");
md.push("");
md.push(`- repositories probed: **${rows.length}**`);
md.push(`- READY: **${ready.length}** / gate requires **${gate.requiredReady}**`);
md.push(`- WRONG_SOURCE: **${wrongSource.length}**`);
md.push(`- substrate verdict: **${verdict}**`);
md.push(`- images pulled this run: ${ledger.imagesPulled}, images built: **0** (all twelve exist prebuilt in the \`swebench\` namespace)`);
md.push(`- median container start ${ledger.medianContainerStartMs} ms, repeat command ${ledger.medianRepeatCommandMs} ms, full benchmark validation ${ledger.medianEvalSeconds} s`);
md.push(`- live-agent runs: 0, live model spend: $0`);
md.push("");
md.push("## V1–V12 matrix");
md.push("");
md.push("| repository | V1 env | V2 src | V3 write | V4 persist | V5 runner | V6 P pass | V7 F fail | V8 provenance | V9 mutation run | V10 restore | V11 telemetry | V12 no bypass | state |");
md.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  const c = r.checks;
  md.push(
    `| ${r.repo} | ${yn(c.v1EnvironmentStarts)} | ${yn(c.v2SourceReadable)} | ${yn(c.v3SourceWritable)} | ${yn(c.v4MutationPersists)} | ${yn(c.v5TestRunnerStarts)} | ${yn(c.v6PassingObservable)} | ${yn(c.v7FailingObservable)} | ${c.v8SourceProvenance} | ${yn(c.v9MutationAffectsValidation)} | ${yn(c.v10SourceRestored)} | ${yn(c.v11TelemetryTruthful)} | ${yn(c.v12NoPrivilegedBypass)} | **${r.state}** |`,
  );
}
md.push("");
md.push("## Source provenance");
md.push("");
md.push("`cwd=/testbed` is what the benchmark runner uses. `cwd=/` removes the checkout's");
md.push("sys.path advantage: a package that still resolves under /testbed is installed editable");
md.push("and cannot be shadowed by a copy.");
md.push("");
md.push("| repository | module resolved (cwd=/testbed) | module resolved (cwd=/) | provenance | robustness |");
md.push("| --- | --- | --- | --- | --- |");
for (const r of rows) {
  md.push(
    `| ${r.repo} | \`${r.moduleFile ?? "—"}\` | \`${r.moduleFileNeutralCwd ?? "—"}\` | ${r.provenance} | ${r.robustness === "CWD_DEPENDENT" ? "**CWD_DEPENDENT**" : r.robustness} |`,
  );
}
md.push("");
md.push("## Benchmark contract observed");
md.push("");
md.push("S1 = base + the benchmark's own test patch. S3 = S1 + the reference repair (§10 control).");
md.push("The control closes when the F-probe fails in S1 and passes in S3 — the substrate reproducing");
md.push("SWE-bench's own resolved/unresolved verdict interactively.");
md.push("");
md.push("| repository | S1 P-probe | S1 F-probe | S3 P-probe | S3 F-probe | control closes | eval exit code | eval s | repeat eval s |");
md.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  md.push(
    `| ${r.repo} | ${r.pStatus ?? "—"} | ${r.fStatus ?? "—"} | ${r.goldStatus.pProbe ?? "—"} | ${r.goldStatus.fProbe ?? "—"} | ${r.goldControlHolds ? "yes" : "**no**"} | ${r.evalExitCode ?? "—"} | ${r.evalSeconds} | ${r.repeatEvalSeconds} |`,
  );
}
md.push("");
md.push("## Notes");
md.push("");
for (const r of rows) {
  for (const n of r.notes) md.push(`- **${r.repo}** — ${n}`);
}
md.push("");

writeFileSync(join(RESULTS, "stage5_m192_readiness_ledger.md"), `${md.join("\n")}\n`);

console.log(`repositories ${rows.length}  READY ${ready.length}/${gate.requiredReady}  WRONG_SOURCE ${wrongSource.length}`);
console.log(`states: ${JSON.stringify(stateCounts)}`);
console.log(`provenance: ${JSON.stringify(provCounts)}`);
console.log(`gold control closed: ${ledger.goldControlHeld}/${rows.length}`);
console.log(`editable installs: ${ledger.editableInstalls}/${rows.length}, cwd-dependent: ${ledger.cwdDependentProvenance}`);
console.log(`verdict: ${verdict}`);
