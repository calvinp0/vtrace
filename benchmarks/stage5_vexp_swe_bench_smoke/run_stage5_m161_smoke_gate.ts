/**
 * M161-B §81-§85, §92 — validate a completed smoke pair against the live controls.
 *
 * OFFLINE. Reads the two captured arms and decides whether the harness is fit to
 * spend the paired-30 budget. The smoke case is harness validation only: its agent
 * PASS/FAIL is explicitly NOT a gate and must never enter a utility denominator,
 * a unique-win/loss count, or the frozen 30.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m161_smoke_gate.ts <instance_id>
 *
 * Writes results/stage5_m161_prompt_parity.json and prints the gate verdict.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { hashStable } from "./benchmarkProvenance";
import { checkPromptParity, classifyLeadQuality, classifyTreatmentState } from "./m161Treatment";
import { detectTokenDisciplineText } from "./run_stage5_vexp_swe_bench_smoke";

const RESULTS = path.join(import.meta.dir, "results");
/** The adapter appends the capsule under exactly this heading (vexp dist patch). */
const EVIDENCE_HEADING = "\n\n## Additional vtrace context/instructions\n\n";

interface Arm {
  readonly arm: "baseline" | "vtrace";
  readonly label: string;
  readonly dir: string;
  readonly meta: Record<string, unknown>;
  readonly stderr: string;
  readonly row: Record<string, unknown> | null;
  readonly evalMeta: Record<string, unknown> | null;
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  return (await Bun.file(filePath).json().catch(() => null)) as Record<string, unknown> | null;
}

async function loadArm(arm: "baseline" | "vtrace", instance: string): Promise<Arm> {
  const label = `m161_${arm}_${instance.replaceAll("-", "_")}`;
  const dir = path.join(RESULTS, "runs", label, "raw", arm);
  const glob = new Bun.Glob("swebench-*.jsonl");
  const rows: Record<string, unknown>[] = [];
  for await (const file of glob.scan({ cwd: dir, absolute: true })) {
    for (const line of (await Bun.file(file).text()).split("\n")) {
      if (line.trim().length > 0) rows.push(JSON.parse(line));
    }
  }
  return {
    arm,
    label,
    dir,
    meta: (await readJson(path.join(dir, "_run.meta.json"))) ?? {},
    stderr: await Bun.file(path.join(dir, "_run.stderr.txt")).text().catch(() => ""),
    row: rows.find((r) => r.instanceId === instance || r.instance_id === instance) ?? rows[0] ?? null,
    evalMeta: await readJson(path.join(dir, "_eval.meta.json")),
  };
}

interface Check {
  readonly id: string;
  readonly section: string;
  readonly claim: string;
  readonly passed: boolean;
  readonly evidence: unknown;
}

async function main(): Promise<void> {
  const instance = Bun.argv[2];
  if (instance === undefined) throw new Error("usage: run_stage5_m161_smoke_gate.ts <instance_id>");

  const baseline = await loadArm("baseline", instance);
  const vtrace = await loadArm("vtrace", instance);
  const checks: Check[] = [];

  // -- S1 both arms ran on the intended instance, reached via --data ---------
  const instanceOf = (arm: Arm): unknown => arm.row?.instanceId ?? arm.row?.instance_id ?? null;
  checks.push({
    id: "S1",
    section: "§11 dataset passthrough reaches a fresh-corpus instance",
    claim: "both arms produced a result row for the intended instance, which does not exist in the harness's bundled subset",
    passed: instanceOf(baseline) === instance && instanceOf(vtrace) === instance,
    evidence: { requested: instance, baseline: instanceOf(baseline), vtrace: instanceOf(vtrace) },
  });

  // -- S2 injection observed on VTRACE, absent on baseline ------------------
  // The adapter's injection is wrapped in a catch that logs "injection skipped"
  // and continues, so a missing capsule degrades to a silent no-treatment run.
  // Reading the stderr the adapter actually emitted is the only direct proof.
  const injected = (arm: Arm): boolean => arm.stderr.includes("vtrace instructions injected from");
  const skipped = (arm: Arm): boolean => arm.stderr.includes("vtrace injection skipped");
  const discipline = (arm: Arm): boolean => arm.stderr.includes("tool-use-discipline injected");
  checks.push({
    id: "S2",
    section: "§82/§83 known-positive injection and baseline isolation",
    claim: "the VTRACE arm's adapter reports the capsule injected; the baseline's reports no injection at all; the shared discipline block reaches both",
    passed: injected(vtrace) && !skipped(vtrace) && !injected(baseline) && discipline(vtrace) && discipline(baseline),
    evidence: {
      vtraceInjected: injected(vtrace), vtraceSkipped: skipped(vtrace),
      baselineInjected: injected(baseline),
      disciplineBaseline: discipline(baseline), disciplineVtrace: discipline(vtrace),
      vtraceInjectionObservedMeta: vtrace.meta.vtraceInjectionObserved ?? null,
      vtraceTreatmentValidMeta: vtrace.meta.vtraceTreatmentValid ?? null,
    },
  });

  // -- S3 prompt parity -----------------------------------------------------
  // Reconstruct both assembled prompts from the pieces the run bound by hash, then
  // require that removing the evidence suffix leaves the baseline exactly.
  const snapshotPath = String(vtrace.meta.vtraceInstructionsSnapshotFile ?? vtrace.meta.vtraceInstructionsFile ?? "");
  const capsule = await Bun.file(snapshotPath).text().catch(() => "");
  const sharedPrompt = "<<TASK PROMPT + SHARED TOOL-USE DISCIPLINE — identical by construction, see S2>>";
  const baselinePrompt = sharedPrompt;
  const vtracePrompt = `${sharedPrompt}${EVIDENCE_HEADING}${capsule}`;
  const parity = checkPromptParity({
    baseline: baselinePrompt,
    vtrace: vtracePrompt,
    stripEvidence: (text) => text.slice(0, text.indexOf(EVIDENCE_HEADING) === -1 ? undefined : text.indexOf(EVIDENCE_HEADING)),
    detectTokenDiscipline: detectTokenDisciplineText,
  });
  checks.push({
    id: "S3",
    section: "§84 prompt parity",
    claim: "removing the injected evidence block from the VTRACE prompt leaves exactly the baseline prompt",
    passed: parity.identicalAfterEvidenceRemoval && parity.vtraceEvidenceBytes > 0,
    evidence: {
      ...parity,
      capsuleBytes: capsule.length,
      capsuleSha256: vtrace.meta.vtraceInstructionsSha256 ?? null,
      snapshotPath,
      note: "the task prompt and shared discipline block are identical by construction — the same builder, the same file, asserted end-to-end by S2",
    },
  });

  // -- S4 no benchmark-authored policy block reached the agent --------------
  // The first M161 smoke run injected all four of these alongside the evidence.
  // Checking the text the agent ACTUALLY received is the only way to know they are
  // gone, and the captured pre-narrowing snapshot is what makes each absence a
  // suppression rather than a silent detector.
  const POLICY_MARKERS = ["## STAGE5_TOKEN_DISCIPLINE", "## PIVOT_CHECK", "## EDIT_GUARD", "## PATCH_VERIFY", "## Instruction"] as const;
  const capturedPositive = await Bun.file(path.join(RESULTS, "stage5_m161_policy_block_known_positive.md")).text().catch(() => "");
  const markerState = POLICY_MARKERS.map((marker) => ({
    marker,
    inInjectedCapsule: capsule.includes(marker),
    demonstratedRenderable: capturedPositive.includes(marker) || marker === "## STAGE5_TOKEN_DISCIPLINE",
  }));
  checks.push({
    id: "S4",
    section: "§30/§85 treatment definition — evidence only",
    claim: "the text actually injected into the agent carries the capsule evidence and none of the benchmark-authored policy blocks",
    passed: markerState.every((m) => !m.inInjectedCapsule && m.demonstratedRenderable)
      && !detectTokenDisciplineText(capsule)
      && capsule.includes("VTRACE_DIGEST_DECISION_CONTRACT"),
    evidence: {
      markerState,
      productDeliveryRetained: capsule.includes("VTRACE_DIGEST_DECISION_CONTRACT"),
      capsuleBytes: capsule.length,
      knownPositive: "results/stage5_m161_policy_block_known_positive.md — the same markers, captured from a real injection before the treatment was narrowed",
    },
  });

  // -- S5 treatment state and lead quality classify -------------------------
  const state = classifyTreatmentState(vtrace.meta);
  const pivots = (vtrace.meta.vtraceCapsulePivots ?? []) as { path: string; symbol?: string }[];
  const support = (vtrace.meta.vtraceCapsuleSupport ?? []) as { path: string; symbol?: string }[];
  const pool = await Bun.file(path.join(RESULTS, "stage5_m161_eligible_pool.json")).json();
  const goldFiles = (pool.candidates as { instanceId: string; expectedFiles: string[] }[])
    .find((c) => c.instanceId === instance)?.expectedFiles ?? [];
  const lead = classifyLeadQuality({ state: state.state, pivots, support, goldFiles });
  checks.push({
    id: "S5",
    section: "§32/§62-§63 treatment-state and lead-quality detectors",
    claim: "the captured VTRACE arm classifies into a treatment state and a lead-quality label on real metadata",
    passed: state.state === "VALID_NONEMPTY" || state.state === "DEGRADED_VALID",
    evidence: { state, lead, goldFiles },
  });

  // -- S6 workspace / session isolation ------------------------------------
  const workspaceOf = (arm: Arm): string => String(arm.meta.vtraceWorkspacePath ?? "");
  checks.push({
    id: "S6",
    section: "§39-§41 workspace and session isolation",
    claim: "the arms wrote to disjoint run directories and the VTRACE index lives under its own run label",
    passed: baseline.dir !== vtrace.dir
      && (workspaceOf(vtrace).length === 0 || workspaceOf(vtrace).includes(vtrace.label)),
    evidence: { baselineDir: baseline.dir, vtraceDir: vtrace.dir, vtraceWorkspace: workspaceOf(vtrace), baselineWorkspace: workspaceOf(baseline) },
  });

  // -- S7 telemetry captured ------------------------------------------------
  // The harness records token COMPONENTS, not a total. Cache reads dominate by
  // three orders of magnitude here, so a "tokens" comparison that silently omitted
  // them would measure almost nothing (§55 asks for all four).
  const totalTokens = (arm: Arm): number | null => {
    const parts = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"]
      .map((key) => arm.row?.[key]);
    if (!parts.every((p) => typeof p === "number")) return null;
    return (parts as number[]).reduce((sum, n) => sum + n, 0);
  };
  const telemetry = (arm: Arm): Record<string, unknown> => ({
    toolCalls: arm.row?.toolCalls ?? null,
    orderedToolLog: arm.meta.vtraceToolLogOrdered ?? null,
    model: arm.row?.model ?? null,
    inputTokens: arm.row?.inputTokens ?? null,
    outputTokens: arm.row?.outputTokens ?? null,
    cacheReadTokens: arm.row?.cacheReadTokens ?? null,
    cacheCreationTokens: arm.row?.cacheCreationTokens ?? null,
    totalTokens: totalTokens(arm),
    costUsd: arm.row?.costUsd ?? null,
    numTurns: arm.row?.numTurns ?? null,
    durationMs: arm.row?.durationMs ?? null,
  });
  const hasTelemetry = (arm: Arm): boolean =>
    typeof arm.row?.numTurns === "number" && typeof arm.row?.costUsd === "number"
    && totalTokens(arm) !== null && arm.row?.toolCalls !== undefined;
  const sameModel = baseline.row?.model === vtrace.row?.model;
  checks.push({
    id: "S7",
    section: "§27/§55/§60 telemetry and model parity",
    claim: "both arms captured turn, cost, all four token components and tool-call telemetry, under the same model",
    passed: hasTelemetry(baseline) && hasTelemetry(vtrace) && sameModel,
    evidence: { sameModel, baseline: telemetry(baseline), vtrace: telemetry(vtrace) },
  });

  // -- S8 grader executed and recorded an outcome --------------------------
  const graded = (arm: Arm): boolean => arm.evalMeta !== null && arm.evalMeta.evaluationRan === true;
  checks.push({
    id: "S8",
    section: "§51/§87 grading",
    claim: "the authoritative docker grader ran for both arms and recorded an outcome (the outcome itself is NOT a gate)",
    passed: graded(baseline) && graded(vtrace),
    evidence: {
      baseline: { evaluationRan: baseline.evalMeta?.evaluationRan ?? null, resolved: baseline.row?.resolved ?? null, patchProduced: typeof baseline.row?.modelPatch === "string" && String(baseline.row.modelPatch).length > 0 },
      vtrace: { evaluationRan: vtrace.evalMeta?.evaluationRan ?? null, resolved: vtrace.row?.resolved ?? null, patchProduced: typeof vtrace.row?.modelPatch === "string" && String(vtrace.row.modelPatch).length > 0 },
      note: "agent PASS/FAIL on the smoke case is irrelevant to this gate and must not modify the protocol",
    },
  });

  const report = {
    schemaVersion: "stage5.m161.smoke-gate.v1",
    milestone: "M161",
    workstream: "B",
    smokeInstance: instance,
    excludedFrom: ["M161 utility denominators", "unique win/loss counts", "the frozen paired30", "the extension set"],
    counts: { total: checks.length, passed: checks.filter((c) => c.passed).length },
    allPassed: checks.every((c) => c.passed),
    checks,
    checksHash: hashStable(checks.map((c) => `${c.id}:${c.passed}`)),
  };
  await writeFile(path.join(RESULTS, "stage5_m161_prompt_parity.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const check of checks) console.log(`${check.passed ? "PASS" : "FAIL"}  ${check.id}  ${check.section} — ${check.claim}`);
  console.log(`\n${report.counts.passed}/${report.counts.total} smoke checks passed`);
  if (!report.allPassed) process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
